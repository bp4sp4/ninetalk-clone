using System.Diagnostics;

namespace NineTalkDaemon;

/// <summary>
/// Quits and relaunches PC KakaoTalk ("재시작 발송": every N recipients). KakaoTalk slows down after many
/// chat windows have been opened and closed; a fresh start keeps long runs steady.
/// Needs KakaoTalk's auto-login: after the restart the daemon waits for the logged-in main window.
/// </summary>
static class KakaoRestart
{
    static readonly string[] KnownPaths =
    {
        @"C:\Program Files\Kakao\KakaoTalk\KakaoTalk.exe",
        @"C:\Program Files (x86)\Kakao\KakaoTalk\KakaoTalk.exe",
    };

    const int ReadyTimeoutSeconds = 90;

    /// <summary>Returns the new KakaoTalk window once it is logged in, or null (not found, cannot quit, or no auto-login).</summary>
    public static async Task<KakaoWindow?> RestartAsync(Action<string> log)
    {
        var running = Process.GetProcessesByName("KakaoTalk");
        string? path = null;
        foreach (var process in running)
        {
            try { path ??= process.MainModule?.FileName; }
            catch { /* another user's or an elevated process */ }
        }
        path ??= KnownPaths.FirstOrDefault(File.Exists);
        if (path is null)
        {
            log("  카카오톡 실행 파일을 찾지 못해 재시작하지 못함");
            return null;
        }

        log("카카오톡 재시작 중…");
        foreach (var process in running)
        {
            try
            {
                process.Kill();
                process.WaitForExit(10_000);
            }
            catch (Exception ex)
            {
                // Typically KakaoTalk runs as administrator and this program does not.
                log($"  카카오톡을 끄지 못함: {ex.Message}");
                return null;
            }
        }

        // From here on KakaoTalk is closed: always start it again, even if the send was stopped meanwhile.
        await Task.Delay(2000);
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(path) });

        var deadline = DateTime.UtcNow.AddSeconds(ReadyTimeoutSeconds);
        var last = KakaoState.NotRunning;
        while (DateTime.UtcNow < deadline)
        {
            await Task.Delay(1000);
            last = KakaoWindow.Detect(out var window);
            if (last == KakaoState.Ready && window is not null)
            {
                await Task.Delay(2000); // let the friend list finish loading
                log("카카오톡 재시작 완료");
                return window;
            }
        }
        log($"  재시작 후 {ReadyTimeoutSeconds}초 안에 로그인 상태가 되지 않음 ({last}). 카카오톡 자동 로그인이 켜져 있는지 확인하세요.");
        return null;
    }
}
