using System.Text.RegularExpressions;

namespace NineTalkDaemon;

/// <summary>
/// One file for everything that went wrong: %LOCALAPPDATA%\NineTalkDaemon\errors.log, appended with date and
/// time, the last 2000 lines kept. Send failures, friend-read problems, KakaoTalk not found, refused requests,
/// crashes, and the desktop app's own errors ([앱]) all land here, so one file is enough to look into a problem.
/// Never friend names or message text: callers pass only codes, counts and recipient numbers.
/// </summary>
static class ErrorLog
{
    public static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NineTalkDaemon", "errors.log");

    const int MaxLines = 3000, KeepLines = 2000;
    static readonly object gate = new();
    static int appended;

    /// <summary>A Windows path, e.g. a job's file (named like the customer's file) quoted in an exception.</summary>
    static readonly Regex WindowsPath = new(@"[A-Za-z]:\\[^\r\n""'<>|]*", RegexOptions.Compiled);

    public static void Add(string area, string message)
    {
        try
        {
            var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} [{area}] {WindowsPath.Replace(message.Trim(), "<경로>")}{Environment.NewLine}";
            lock (gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
                // Shared, so the desktop app ([앱]) can append to the same file at the same moment.
                using (var stream = new FileStream(LogPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
                using (var writer = new StreamWriter(stream))
                    writer.Write(line);
                // Checked on the first line of each run and every 50 after, by size (cheap), then trimmed.
                if (appended++ % 50 == 0 && new FileInfo(LogPath).Length > 400_000)
                {
                    var lines = File.ReadAllLines(LogPath);
                    if (lines.Length > MaxLines) File.WriteAllLines(LogPath, lines[^KeepLines..]);
                }
            }
        }
        catch { /* the log must never break what it logs */ }
    }

    static readonly string[] ProblemWords = { "실패", "오류", "못 ", "못함", "못했", "멈춥니다", "알 수 없", "찾지 못", "안 뜸", "뜨지 않음", "남음", "아님", "partial_sent", "unknown_result", "send_failed", "not_found", "duplicate_name", "room_mismatch", "input_not_empty", "kakao_not_ready" };

    /// <summary>Whether a send-log line reports a problem (those go to errors.log as well).</summary>
    public static bool LooksLikeProblem(string line) => ProblemWords.Any(word => line.Contains(word, StringComparison.Ordinal));
}
