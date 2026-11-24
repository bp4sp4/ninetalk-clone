namespace NineTalkDaemon;

/// <summary>Runs one send job (POST /send) at a time and keeps the last job's results (GET /send/result).</summary>
sealed class SendService
{
    public sealed record Recipient(long Id, string Name, string? Text);
    public sealed record Result(long Id, string Status, string? Error);

    /// <summary>A file attachment: the name the recipient sees, and its bytes.</summary>
    public sealed record SendFile(string Name, byte[] Data);

    /// <summary>
    /// Images and files sent to every recipient, before or after the text (POST /send "images", "files",
    /// "image_first"). Images go first, then files.
    /// </summary>
    public sealed record Attachments(IReadOnlyList<byte[]> Images, IReadOnlyList<SendFile> Files, bool ImageFirst)
    {
        public static readonly Attachments None = new(Array.Empty<byte[]>(), Array.Empty<SendFile>(), false);
        public int Count => Images.Count + Files.Count;
    }

    /// <summary>
    /// Removes the folders of earlier jobs' files that are over 30 minutes old: younger ones may still be
    /// uploading, or belong to another run (the tray program and a --send-test at the same time).
    /// </summary>
    static void RemoveFileFolders()
    {
        // Also the folder 0.1.6~0.1.8 used, which KakaoTalk could not read from (see FilesRoot).
        var oldRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NineTalkDaemon");
        foreach (var root in new[] { FilesRoot, oldRoot })
        {
            try
            {
                foreach (var dir in Directory.GetDirectories(root, "files-*"))
                {
                    if (DateTime.Now - Directory.GetCreationTime(dir) < TimeSpan.FromMinutes(30)) continue;
                    try { Directory.Delete(dir, recursive: true); } catch { /* in use: next time */ }
                }
            }
            catch { /* no folder yet */ }
        }
    }

    /// <summary>
    /// Where a job's files are written for KakaoTalk to pick in its file window (it reads them while it uploads).
    /// Not under AppData: KakaoTalk's file window says "경로가 없습니다" for a file there (KakaoTalk 26.8,
    /// 2026-11-24, while the same file elsewhere opens). Not Documents or Desktop either: those are often synced
    /// to OneDrive, and these are customers' files.
    /// </summary>
    static readonly string FilesRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "NineTalkFiles");

    /// <summary>
    /// Pacing from POST /send: pause after each recipient (on top of the ~3s one send takes), and in
    /// "restart" mode a KakaoTalk restart every <see cref="SplitCount"/> recipients.
    /// </summary>
    public sealed record Settings(int IntervalMs, int? SplitCount, bool Restart)
    {
        public const int MinIntervalMs = 200, MaxIntervalMs = 2000;

        /// <summary>From the request; interval_ms wins, else the old 1~5 speed_rate.</summary>
        public static Settings From(int? intervalMs, int? speedRate, int? splitCount, string? mode)
        {
            int[] legacy = { 800, 2000, 1200, 800, 400, 200 };
            var interval = intervalMs ?? legacy[Math.Clamp(speedRate ?? 3, 1, 5)];
            return new Settings(Math.Clamp(interval, MinIntervalMs, MaxIntervalMs), splitCount is > 0 ? splitCount : null, mode == "restart");
        }
    }

    readonly object gate = new();
    CancellationTokenSource? running;
    long jobId;
    string state = "done";
    int processed;
    List<Result> results = new();

    public event Action<string>? Log;

    public static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NineTalkDaemon", "last-send.log");

    /// <summary>Set by the tray: true while a friend read is running, so the two never share the window.</summary>
    public Func<bool>? OtherBusy { get; set; }

    public bool IsRunning { get { lock (gate) return running is not null; } }
    public int Processed { get { lock (gate) return processed; } }

    public (long jobId, string state, List<Result> results) Snapshot()
    {
        lock (gate) return (jobId, state, new List<Result>(results));
    }

    /// <summary>Starts a job. Returns null when started, otherwise the status that prevents it.</summary>
    public string? TryStart(long id, List<Recipient> recipients, Settings settings, bool dryRun = false, Attachments? attachments = null)
    {
        lock (gate)
        {
            if (running is not null) return "SendMessage";
            if (OtherBusy?.Invoke() == true) return "GetKaoFriends";
            var kakaoState = KakaoWindow.Detect(out var kakao);
            if (kakaoState != KakaoState.Ready || kakao is null) return kakaoState.ToString();

            var cts = new CancellationTokenSource();
            running = cts;
            jobId = id;
            state = "running";
            processed = 0;
            results = new List<Result>();
            _ = Task.Run(() => Run(kakao, recipients, settings, attachments ?? Attachments.None, dryRun, cts));
            return null;
        }
    }

    public void Stop()
    {
        lock (gate) running?.Cancel();
    }

    /// <summary>Runs a job on the calling thread and returns its results (used by --send-test).</summary>
    public async Task<List<Result>> RunNowAsync(List<Recipient> recipients, bool dryRun, Attachments? attachments = null)
    {
        if (TryStart(0, recipients, new Settings(2000, null, false), dryRun, attachments) is string refused) throw new InvalidOperationException("시작할 수 없음: " + refused);
        while (IsRunning) await Task.Delay(200);
        return Snapshot().results;
    }

    async Task Run(KakaoWindow kakao, List<Recipient> recipients, Settings settings, Attachments attachments, bool dryRun, CancellationTokenSource cts)
    {
        var ct = cts.Token;
        // Per-job log (overwritten each job), without names or message text, for finding out where a send
        // went wrong: %LOCALAPPDATA%\NineTalkDaemon\last-send.log
        StreamWriter? file = null;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            file = new StreamWriter(LogPath, append: false) { AutoFlush = true };
        }
        catch { /* no log file: the send still runs */ }
        void Write(string msg)
        {
            try { lock (gate) file?.WriteLine($"{DateTime.Now:HH:mm:ss} {msg}"); } catch { }
            // The job's start and end give the problems their context in errors.log.
            // OCR'd button text stays out of errors.log (it is read off the screen, so it could hold anything).
            if (!msg.Contains("버튼 주변 글자") && (ErrorLog.LooksLikeProblem(msg) || msg.StartsWith("발송 시작") || msg.StartsWith("발송 끝")))
                ErrorLog.Add("발송", msg);
            Log?.Invoke(msg);
        }
        bool wasShown = kakao.MainShown, wasIconic = Native.IsIconic(kakao.Main);
        bool wasChatTab = kakao.ChatTabSelected;
        var s = Native.GetDpiForWindow(kakao.Main) / 96.0;
        string finalState = "done";
        Write($"발송 시작: {recipients.Count}명, {settings.IntervalMs}ms 간격"
            + (settings.Restart && settings.SplitCount is int every ? $", {every}명마다 카카오톡 재시작" : "")
            + (attachments.Images.Count > 0 ? $", 이미지 {attachments.Images.Count}장" : "")
            + (attachments.Files.Count > 0 ? $", 파일 {attachments.Files.Count}개" : "")
            + (attachments.Count > 0 && attachments.ImageFirst ? " (첨부 먼저)" : "")
            + (dryRun ? " (dry-run)" : ""));
        // Files are written once per job, each in a folder of its own so the recipient sees its original name.
        // Kept a few minutes after the job (KakaoTalk may still be reading the last one); folders left by an
        // earlier job are removed first (they can hold customers' files).
        var filesDir = Path.Combine(FilesRoot, $"files-{Environment.ProcessId}-{DateTime.Now.Ticks}");
        var filePaths = new List<string>();
        try
        {
            RemoveFileFolders();
            for (int n = 0; n < attachments.Files.Count; n++)
            {
                var dir = Path.Combine(filesDir, (n + 1).ToString());
                Directory.CreateDirectory(dir);
                var filePath = Path.Combine(dir, attachments.Files[n].Name);
                File.WriteAllBytes(filePath, attachments.Files[n].Data);
                filePaths.Add(filePath);
            }

            if (!wasShown)
            {
                Native.ShowWindow(kakao.Main, Native.SW_SHOWNOACTIVATE);
                await Task.Delay(400, ct);
            }

            for (int i = 0; i < recipients.Count; i++)
            {
                if (ct.IsCancellationRequested) { finalState = "stopped"; break; }
                var r = recipients[i];
                string? error;
                if (!kakao.Ready) error = "kakao_not_ready";
                else if (string.IsNullOrWhiteSpace(r.Text) && attachments.Count == 0) error = "send_failed"; // nothing to send
                else
                {
                    try
                    {
                        error = await KakaoSender.SendOneAsync(kakao, r.Name, string.IsNullOrWhiteSpace(r.Text) ? "" : r.Text, attachments.Images,
                            filePaths, attachments.ImageFirst, dryRun, m => Write(m), CancellationToken.None);
                    }
                    catch (Exception ex) { Write($"  #{r.Id}: {ex.Message}"); error = "send_failed"; }
                }
                // "_stop": a file step that would fail the same way for everyone; recorded without the marker.
                bool stopJob = error?.EndsWith(KakaoSender.StopSuffix) == true;
                if (stopJob) error = error![..^KakaoSender.StopSuffix.Length];
                Write($"{i + 1}/{recipients.Count} #{r.Id}: {error ?? (dryRun ? "dry-run ok" : "sent")}");
                lock (gate)
                {
                    results.Add(new Result(r.Id, error is null ? "sent" : "failed", error));
                    processed = results.Count;
                }
                if (error == "kakao_not_ready") { finalState = "failed"; break; }
                if (stopJob)
                {
                    Write("파일을 보내지 못해 멈춥니다 (다른 사람도 같을 것이라, 남은 사람은 대기로 돌아감)");
                    finalState = "failed";
                    break;
                }
                // Unknown whether it went out (a file sent with no window, a window left open): that would happen
                // to everyone the same way, so stop here; the rest go back to waiting instead of all ending unknown.
                if (error == "unknown_result")
                {
                    Write("보냈는지 알 수 없는 결과가 나와 멈춥니다 (남은 사람은 대기로 돌아감)");
                    finalState = "failed";
                    break;
                }

                if (i == recipients.Count - 1) break;
                try { await Task.Delay(settings.IntervalMs, ct); }
                catch (OperationCanceledException) { finalState = "stopped"; break; }

                if (settings.Restart && settings.SplitCount is int n && (i + 1) % n == 0)
                {
                    var restarted = await KakaoRestart.RestartAsync(m => Write(m));
                    if (restarted is null) { finalState = "failed"; break; } // the rest goes back to the queue
                    kakao = restarted;
                    // KakaoTalk may come back hidden in the tray; captures need the window shown.
                    if (!kakao.MainShown)
                    {
                        Native.ShowWindow(kakao.Main, Native.SW_SHOWNOACTIVATE);
                        await Task.Delay(400);
                    }
                }
            }
        }
        catch (OperationCanceledException) { finalState = "stopped"; }
        catch (Exception ex)
        {
            Write("발송 오류: " + ex.Message);
            finalState = "failed";
        }
        finally
        {
            try
            {
                if (wasChatTab) FriendListReader.Click(kakao.OnlineView, (int)Math.Round(FriendListReader.TabX * s), (int)Math.Round(FriendListReader.ChatTabY * s));
                if (!wasShown)
                {
                    // KakaoTalk brings its main window back when a chat it opened closes, sometimes
                    // after we hid it, so hide again once things settle.
                    for (int i = 0; i < 3; i++)
                    {
                        Native.ShowWindow(kakao.Main, wasIconic ? Native.SW_SHOWMINNOACTIVE : Native.SW_HIDE);
                        await Task.Delay(700);
                        if (!kakao.MainShown) break;
                    }
                }
            }
            catch { /* restoring is best effort */ }
            lock (gate) { state = finalState; running = null; }
            Write($"발송 끝: {finalState}");
            if (filePaths.Count > 0)
                _ = Task.Delay(TimeSpan.FromMinutes(5)).ContinueWith(_ =>
                {
                    // Only this job's folder: a later job may be using its own by then.
                    try { Directory.Delete(filesDir, recursive: true); } catch { /* the next job removes it */ }
                }, TaskScheduler.Default);
            cts.Dispose();
            file?.Dispose();
        }
    }
}
