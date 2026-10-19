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

        // --send-test <name> <text> [--send]: one recipient through the same code as POST /send.
        // Dry-run (stops before Enter in the chat) unless --send is given.
        if (args.Length > 2 && args[0] == "--send-test")
        {
            SendTest(args[1], args[2], dryRun: !args.Contains("--send"));
            return;
        }

        // --parent-pid <pid>: started by the desktop app (desktop/main.js); exit when it exits.
        var parentIndex = Array.IndexOf(args, "--parent-pid");
        int? parentPid = parentIndex >= 0 && parentIndex + 1 < args.Length && int.TryParse(args[parentIndex + 1], out var pid) ? pid : null;
        Application.Run(new TrayContext(parentPid));
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);

    static void SendTest(string name, string text, bool dryRun)
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
            var results = sender.RunNowAsync(new() { new SendService.Recipient(1, name, text) }, dryRun).GetAwaiter().GetResult();
            foreach (var r in results)
                Print("결과: " + (r.Error is not null ? $"failed {r.Error}" : dryRun ? "dry-run ok (보내지 않음)" : "sent"));
        }
        catch (Exception ex) { Print("오류: " + ex.Message); }
        Print("로그: " + log);
    }
}
