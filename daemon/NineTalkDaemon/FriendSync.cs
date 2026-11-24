namespace NineTalkDaemon;

/// <summary>Runs one friend-list read at a time in the background and keeps the last result.</summary>
sealed class FriendSync
{
    /// <summary>Per-run log (overwritten on each read): %LOCALAPPDATA%\NineTalkDaemon\last-sync.log</summary>
    public static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NineTalkDaemon", "last-sync.log");

    readonly object gate = new();
    CancellationTokenSource? running;
    int count;
    List<FriendName> result = new();
    ReadSummary? summary;
    string? lastError;

    public event Action<string>? Log;

    /// <summary>Set by the tray: true while a send job runs, so the two never share the window.</summary>
    public Func<bool>? OtherBusy { get; set; }

    public bool IsRunning { get { lock (gate) return running is not null; } }

    public (string status, int count, string? error) Status()
    {
        lock (gate)
        {
            if (running is not null) return ("GetKaoFriends", count, null);
        }
        return (KakaoWindow.Detect(out _).ToString(), count, lastError);
    }

    public (List<FriendName> friends, ReadSummary? summary) Result()
    {
        lock (gate) return (new List<FriendName>(result), summary);
    }

    /// <summary>Starts a read. Returns null when started, otherwise the status that prevents it.</summary>
    public string? TryStart(string keyword)
    {
        lock (gate)
        {
            if (running is not null) return "GetKaoFriends";
            if (OtherBusy?.Invoke() == true) return "SendMessage";
            var state = KakaoWindow.Detect(out var kakao);
            if (state != KakaoState.Ready || kakao is null) return state.ToString();

            var cts = new CancellationTokenSource();
            running = cts;
            count = 0;
            result = new List<FriendName>();
            summary = null;
            lastError = null;
            _ = Task.Run(() => Run(kakao, keyword, cts));
            return null;
        }
    }

    public void Stop()
    {
        lock (gate) running?.Cancel();
    }

    async Task Run(KakaoWindow kakao, string keyword, CancellationTokenSource cts)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
        using var file = new StreamWriter(LogPath, append: false) { AutoFlush = true };
        void Write(string msg)
        {
            lock (file) file.WriteLine($"{DateTime.Now:HH:mm:ss} {msg}");
            Log?.Invoke(msg);
        }

        Write(keyword.Length == 0 ? "친구 목록 읽기 시작" : $"친구 검색 '{keyword}' 시작");
        try
        {
            var done = await FriendListReader.ReadAsync(kakao, friend =>
            {
                // Start-search keeps only names containing the keyword. Filtering here instead of typing
                // into KakaoTalk's search box means the daemon never puts focus on a box where Enter opens a chat.
                if (keyword.Length > 0 && !friend.Name.Contains(keyword, StringComparison.OrdinalIgnoreCase)) return;
                lock (gate) { result.Add(friend); count = result.Count; }
            }, cts.Token, Write);
            lock (gate) summary = done;
            Write($"친구 {count}명 읽음");
            if (done.Unreadable > 0 || done.Expected is int shown && done.Read + done.Unreadable < shown)
                ErrorLog.Add("친구 불러오기", $"읽은 친구 {done.Read}명, 카카오톡 표시 {done.Expected?.ToString() ?? "?"}명, 못 읽은 행 {done.Unreadable}개 (자세한 것은 last-sync.log)");
        }
        catch (OperationCanceledException)
        {
            Write($"중단됨 ({count}명까지 읽음)");
        }
        catch (Exception ex)
        {
            lock (gate) lastError = ex.Message;
            Write("오류: " + ex.Message);
            ErrorLog.Add("친구 불러오기", $"{count}명 읽고 멈춤: {ex.Message}");
        }
        finally
        {
            lock (gate) { running = null; }
            cts.Dispose();
        }
    }
}
