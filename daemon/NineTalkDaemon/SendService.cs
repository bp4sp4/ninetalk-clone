namespace NineTalkDaemon;

/// <summary>Runs one send job (POST /send) at a time and keeps the last job's results (GET /send/result).</summary>
sealed class SendService
{
    public sealed record Recipient(long Id, string Name, string? Text);
    public sealed record Result(long Id, string Status, string? Error);

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

    /// <summary>Set by the tray: true while a friend read is running, so the two never share the window.</summary>
    public Func<bool>? OtherBusy { get; set; }

    public bool IsRunning { get { lock (gate) return running is not null; } }
    public int Processed { get { lock (gate) return processed; } }

    public (long jobId, string state, List<Result> results) Snapshot()
    {
        lock (gate) return (jobId, state, new List<Result>(results));
    }

    /// <summary>Starts a job. Returns null when started, otherwise the status that prevents it.</summary>
    public string? TryStart(long id, List<Recipient> recipients, Settings settings, bool dryRun = false)
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
            _ = Task.Run(() => Run(kakao, recipients, settings, dryRun, cts));
            return null;
        }
    }

    public void Stop()
    {
        lock (gate) running?.Cancel();
    }

    /// <summary>Runs a job on the calling thread and returns its results (used by --send-test).</summary>
    public async Task<List<Result>> RunNowAsync(List<Recipient> recipients, bool dryRun)
    {
        if (TryStart(0, recipients, new Settings(2000, null, false), dryRun) is string refused) throw new InvalidOperationException("시작할 수 없음: " + refused);
        while (IsRunning) await Task.Delay(200);
        return Snapshot().results;
    }

    async Task Run(KakaoWindow kakao, List<Recipient> recipients, Settings settings, bool dryRun, CancellationTokenSource cts)
    {
        var ct = cts.Token;
        bool wasShown = kakao.MainShown, wasIconic = Native.IsIconic(kakao.Main);
        bool wasChatTab = kakao.ChatTabSelected;
        var s = Native.GetDpiForWindow(kakao.Main) / 96.0;
        string finalState = "done";
        Log?.Invoke($"발송 시작: {recipients.Count}명, {settings.IntervalMs}ms 간격"
            + (settings.Restart && settings.SplitCount is int every ? $", {every}명마다 카카오톡 재시작" : "")
            + (dryRun ? " (dry-run)" : ""));
        try
        {
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
                else if (string.IsNullOrEmpty(r.Text)) error = "send_failed"; // image-only messages are not supported yet
                else
                {
                    try { error = await KakaoSender.SendOneAsync(kakao, r.Name, r.Text, dryRun, m => Log?.Invoke(m), CancellationToken.None); }
                    catch (Exception ex) { Log?.Invoke($"  {r.Name}: {ex.Message}"); error = "send_failed"; }
                }
                Log?.Invoke($"{i + 1}/{recipients.Count} {r.Name}: {error ?? (dryRun ? "dry-run ok" : "sent")}");
                lock (gate)
                {
                    results.Add(new Result(r.Id, error is null ? "sent" : "failed", error));
                    processed = results.Count;
                }
                if (error == "kakao_not_ready") { finalState = "failed"; break; }

                if (i == recipients.Count - 1) break;
                try { await Task.Delay(settings.IntervalMs, ct); }
                catch (OperationCanceledException) { finalState = "stopped"; break; }

                if (settings.Restart && settings.SplitCount is int n && (i + 1) % n == 0)
                {
                    var restarted = await KakaoRestart.RestartAsync(m => Log?.Invoke(m));
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
            Log?.Invoke("발송 오류: " + ex.Message);
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
            Log?.Invoke($"발송 끝: {finalState}");
            cts.Dispose();
        }
    }
}
