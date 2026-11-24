namespace NineTalkDaemon;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        // Sets PerMonitorV2 DPI awareness, so window rects and captures are in physical pixels.
        ApplicationConfiguration.Initialize();

        // Diagnostics (see README): --probe [outDir] inspects KakaoTalk read-only,
        // --replay <dir> re-runs the reader over captures saved with NINETALK_DEBUG_DIR.
        if (args.Length > 0 && args[0] == "--probe")
        {
            Probe.RunAsync(args.Length > 1 ? args[1] : "probe-output").GetAwaiter().GetResult();
            return;
        }
        if (args.Length > 1 && args[0] == "--replay")
        {
            File.WriteAllText(Path.Combine(args[1], "replay.txt"), FriendListReader.ReplayAsync(args[1]).GetAwaiter().GetResult());
            return;
        }

        // --send-test <name> <text> [--image <file>]... [--image-first] [--send]: one recipient through the
        // same code as POST /send. Dry-run (puts the text in and clears it, opens the image window and cancels
        // it) unless --send is given. Text "" sends only the images.
        if (args.Length > 2 && args[0] == "--send-test")
        {
            var images = new List<byte[]>();
            for (int i = 3; i < args.Length - 1; i++)
                if (args[i] == "--image") images.Add(File.ReadAllBytes(args[i + 1]));
            SendTest(args[1], args[2], dryRun: !args.Contains("--send"), new SendService.Attachments(images, args.Contains("--image-first")));
            return;
        }

        // --restart-test: quits and relaunches PC KakaoTalk the way "재시작 발송" does, then waits for login.
        // Sends nothing. Log: %LOCALAPPDATA%\NineTalkDaemon\restart-test.log
        if (args.Length > 0 && args[0] == "--restart-test")
        {
            AttachConsole(-1);
            var log = Path.Combine(Path.GetDirectoryName(FriendSync.LogPath)!, "restart-test.log");
            Directory.CreateDirectory(Path.GetDirectoryName(log)!);
            using var file = new StreamWriter(log, append: false) { AutoFlush = true };
            void Print(string s) { Console.WriteLine(s); file.WriteLine($"{DateTime.Now:HH:mm:ss} {s}"); }
            var started = DateTime.Now;
            var window = KakaoRestart.RestartAsync(Print).GetAwaiter().GetResult();
            Print(window is null
                ? "결과: 실패"
                : $"결과: 로그인 상태로 다시 켜짐 ({(DateTime.Now - started).TotalSeconds:F0}초, 창 표시={window.MainShown})");
            return;
        }

        // --parent-pid <pid>: started by the desktop app (desktop/main.js); exit when it exits.
        var parentIndex = Array.IndexOf(args, "--parent-pid");
        int? parentPid = parentIndex >= 0 && parentIndex + 1 < args.Length && int.TryParse(args[parentIndex + 1], out var pid) ? pid : null;
        Application.Run(new TrayContext(parentPid));
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);

    static void SendTest(string name, string text, bool dryRun, SendService.Attachments attachments)
    {
        AttachConsole(-1);
        var log = Path.Combine(Path.GetDirectoryName(FriendSync.LogPath)!, "send-test.log");
        Directory.CreateDirectory(Path.GetDirectoryName(log)!);
        using var file = new StreamWriter(log, append: false) { AutoFlush = true };
        void Print(string s) { Console.WriteLine(s); file.WriteLine($"{DateTime.Now:HH:mm:ss} {s}"); }

        var sender = new SendService();
        sender.Log += Print;
        try
        {
            var results = sender.RunNowAsync(new() { new SendService.Recipient(1, name, text) }, dryRun, attachments).GetAwaiter().GetResult();
            foreach (var r in results)
                Print("결과: " + (r.Error is not null ? $"failed {r.Error}" : dryRun ? "dry-run ok (보내지 않음)" : "sent"));
        }
        catch (Exception ex) { Print("오류: " + ex.Message); }
        Print("로그: " + log);
    }
}
