namespace NineTalkDaemon;

/// <summary>System tray icon that hosts the local HTTP server.</summary>
sealed class TrayContext : ApplicationContext
{
    readonly NotifyIcon icon;
    readonly FriendSync sync = new();
    readonly SendService sender = new();
    readonly HttpServer? server;
    readonly ToolStripMenuItem statusItem = new("상태 확인 중...") { Enabled = false };
    readonly ToolStripMenuItem lastLogItem = new("") { Enabled = false, Visible = false };
    readonly System.Windows.Forms.Timer timer = new() { Interval = 2000 };
    /// <summary>The desktop app that started this daemon (--parent-pid); when it is gone, exit too.</summary>
    readonly System.Diagnostics.Process? parent;

    public TrayContext(int? parentPid = null)
    {
        if (parentPid is int pid)
        {
            try { parent = System.Diagnostics.Process.GetProcessById(pid); }
            catch (ArgumentException) { } // already gone: run standalone
        }

        var menu = new ContextMenuStrip();
        menu.Items.Add(statusItem);
        menu.Items.Add(lastLogItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("친구 읽기 중단", null, (_, _) => sync.Stop());
        menu.Items.Add("발송 중단", null, (_, _) => sender.Stop());
        menu.Items.Add("종료", null, (_, _) => ExitThread());

        icon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "NineTalk 데몬",
            ContextMenuStrip = menu,
            Visible = true,
        };

        var ui = SynchronizationContext.Current!;
        void ShowLog(string msg) => ui.Post(_ => { lastLogItem.Text = msg.Length > 60 ? msg[..60] + "…" : msg; lastLogItem.Visible = true; }, null);
        sync.Log += ShowLog;
        sender.Log += ShowLog;
        // A friend read and a send job both drive the KakaoTalk window, so only one runs at a time.
        sync.OtherBusy = () => sender.IsRunning;
        sender.OtherBusy = () => sync.IsRunning;

        try
        {
            server = new HttpServer(sync, sender);
            server.ShutdownRequested += () => ui.Post(_ => ExitThread(), null);
            server.Start();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"localhost:{HttpServer.Port} 포트를 열지 못했습니다.\n다른 프로그램(mock-daemon 등)이 쓰고 있는지 확인하세요.\n\n{ex.Message}",
                "NineTalk 데몬", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        timer.Tick += (_, _) =>
        {
            if (parent is { HasExited: true }) { ExitThread(); return; }
            RefreshStatus();
        };
        timer.Start();
        RefreshStatus();
    }

    void RefreshStatus()
    {
        var (status, count, _) = sync.Status();
        if (sender.IsRunning) (status, count) = ("SendMessage", sender.Processed);
        var label = status switch
        {
            "SendMessage" => $"발송 중 ({count}명 처리)",
            "Ready" => "카카오톡 준비됨",
            "GetKaoFriends" => $"친구 읽는 중 ({count}명)",
            "NotRunning" => "카카오톡 꺼짐",
            "LoggedOut" => "카카오톡 로그아웃",
            "Locked" => "카카오톡 잠금",
            _ => status,
        };
        statusItem.Text = server is null ? "서버 시작 실패" : $"{label} · localhost:{HttpServer.Port}";
        icon.Text = $"NineTalk 데몬 - {label}";
    }

    protected override void ExitThreadCore()
    {
        timer.Stop();
        sync.Stop();
        sender.Stop();
        server?.Dispose();
        icon.Visible = false;
        icon.Dispose();
        base.ExitThreadCore();
    }
}
