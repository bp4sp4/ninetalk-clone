using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace NineTalkDaemon;

/// <summary>
/// Diagnostic mode: NineTalkDaemon.exe --probe [outDir]
/// Read-only. Prints the KakaoTalk window tree and state, captures the window with PrintWindow
/// and, only when the friend tab is selected, runs OCR on the friend list.
/// </summary>
static class Probe
{
    [DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);

    public static async Task RunAsync(string outDir)
    {
        AttachConsole(-1);
        Directory.CreateDirectory(outDir);
        var log = new StringWriter();
        void Print(string s) { Console.WriteLine(s); log.WriteLine(s); }

        var state = KakaoWindow.Detect(out var kakao);
        Print($"state={state} koreanOcr={Ocr.KoreanAvailable}");
        if (kakao is null) { await File.WriteAllTextAsync(Path.Combine(outDir, "probe.txt"), log.ToString()); return; }

        Print($"main=0x{kakao.Main:X} shown={kakao.MainShown} iconic={Native.IsIconic(kakao.Main)} rect={Native.WindowRect(kakao.Main)}");
        foreach (var child in Native.ChildWindows(kakao.Main))
            Print($"  0x{child:X} parent=0x{Native.GetParent(child):X} {Native.ClassName(child)} '{Native.WindowText(child)}' wsVisible={Native.HasVisibleStyle(child)} rect={Native.WindowRect(child)}");
        Print($"friendTabSelected={kakao.FriendTabSelected}");

        using (var full = Capture.Window(kakao.Main))
        {
            if (full is null) Print("capture: window has no size");
            else
            {
                Print($"capture: {full.Width}x{full.Height} nonBlack={Capture.NonBlackRatio(full):P0}");
                // Save the full window only on the friend tab, so chat previews are never written to disk.
                if (kakao.FriendTabSelected) full.Save(Path.Combine(outDir, "main.png"), ImageFormat.Png);
            }
        }

        if (kakao.FriendTabSelected && kakao.ContactList != IntPtr.Zero)
        {
            using var list = Capture.Child(kakao.Main, kakao.ContactList);
            if (list is not null)
            {
                list.Save(Path.Combine(outDir, "contact-list.png"), ImageFormat.Png);
                foreach (var line in await Ocr.RecognizeAsync(list))
                    Print($"  ocr {line.Bounds} '{line.Text}'");
            }
        }
        else Print("friend tab is not selected: skipping OCR");

        await File.WriteAllTextAsync(Path.Combine(outDir, "probe.txt"), log.ToString());
    }
}
