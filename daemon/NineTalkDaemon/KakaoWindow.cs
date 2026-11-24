using System.Diagnostics;

namespace NineTalkDaemon;

public enum KakaoState { NotRunning, LoggedOut, Locked, Ready }

/// <summary>
/// Handles to the PC KakaoTalk main window and the views inside it.
/// KakaoTalk (EVA UI toolkit) names its child windows "ViewName_0x{hwnd}", e.g.
/// OnlineMainView_0x000104dc > ContactListView_0x000104de > ContactListCtrl_0x000104e6.
/// </summary>
public sealed class KakaoWindow
{
    public IntPtr Main { get; private init; }
    public IntPtr OnlineView { get; private init; }
    public IntPtr LockView { get; private init; }
    public IntPtr ContactView { get; private init; }
    public IntPtr ContactList { get; private init; }
    public IntPtr ChatRoomView { get; private init; }
    public IntPtr FriendSearchEdit { get; private init; }   // Edit inside ContactListView
    public IntPtr FriendSearchList { get; private init; }   // SearchListCtrl inside ContactListView
    public uint ProcessId { get; private init; }

    const string MainClass = "EVA_Window_Dblclk";

    /// <summary>
    /// Finds the main window and judges the login state. Read-only: sends no messages.
    /// Every KakaoTalk window is looked at (chat windows have the same class as the main window) and the best
    /// state wins: Ready over Locked over LoggedOut, so one odd window cannot make KakaoTalk look logged out.
    /// When KakaoTalk is not found Ready, what was seen is written to kakao-detect.log (see Diagnose).
    /// </summary>
    public static KakaoState Detect(out KakaoWindow? window)
    {
        window = null;
        var processes = Process.GetProcessesByName("KakaoTalk");
        try
        {
            if (processes.Length == 0)
            {
                Diagnose(KakaoState.NotRunning, processes);
                return KakaoState.NotRunning;
            }

            var best = KakaoState.LoggedOut;
            foreach (var process in processes)
            {
                foreach (var top in Native.TopLevelWindows((uint)process.Id))
                {
                    if (Native.ClassName(top) != MainClass) continue;
                    var found = FromMain(top);
                    if (found is null) continue;
                    var state = found.LockView != IntPtr.Zero && Native.HasVisibleStyle(found.LockView) ? KakaoState.Locked
                        : found.OnlineView != IntPtr.Zero && Native.HasVisibleStyle(found.OnlineView) ? KakaoState.Ready
                        : KakaoState.LoggedOut;
                    if (state == KakaoState.Ready)
                    {
                        window = found;
                        lastDiagnosedState = null; // a later problem is new again and gets logged
                        return KakaoState.Ready;
                    }
                    if (window is null || state == KakaoState.Locked) { window = found; best = state; }
                }
            }
            // The process is up but no window has the logged-in view: login screen, still starting, or locked.
            Diagnose(best, processes);
            return best;
        }
        finally
        {
            foreach (var process in processes) process.Dispose();
        }
    }

    public static readonly string DiagnosePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NineTalkDaemon", "kakao-detect.log");
    static long lastDiagnoseTicks = long.MinValue / 2;
    static KakaoState? lastDiagnosedState;

    /// <summary>
    /// Writes what was seen when KakaoTalk is not Ready (when the state changes, otherwise at most once a minute;
    /// appended, the last 300 lines kept, so the moment it went wrong is not overwritten): processes, and per
    /// top-level window its class, visibility, title length (titles of chat windows are friends' names, so only
    /// their length) and which KakaoTalk views it holds.
    /// </summary>
    static void Diagnose(KakaoState state, Process[] processes)
    {
        // TickCount64: a clock set back must not stop the log.
        if (state == lastDiagnosedState && Environment.TickCount64 - lastDiagnoseTicks < 60_000) return;
        if (state != lastDiagnosedState)
            ErrorLog.Add("카카오톡", $"카카오톡 상태 {state} (로그인된 메인 창을 찾지 못함, 자세한 것은 kakao-detect.log)");
        lastDiagnoseTicks = Environment.TickCount64;
        lastDiagnosedState = state;
        try
        {
            var lines = new List<string> { $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} 판정: {state}, KakaoTalk 프로세스 {processes.Length}개" };
            foreach (var process in processes)
            {
                string path;
                try { path = process.MainModule?.FileName ?? "?"; } catch (Exception ex) { path = $"(경로를 읽을 수 없음: {ex.Message})"; }
                lines.Add($"프로세스 {process.Id}: {path}");
                foreach (var top in Native.TopLevelWindows((uint)process.Id))
                {
                    var views = Native.ChildWindows(top).Select(Native.WindowText)
                        .Select(name => name.Split('_')[0])
                        .Where(name => name is "OnlineMainView" or "LockModeView" or "ContactListView" or "ChatRoomListView")
                        .Distinct();
                    lines.Add($"  창 0x{top:X} {Native.ClassName(top)} 보임={Native.IsWindowVisible(top)} 최소화={Native.IsIconic(top)} "
                        + $"제목 {Native.WindowText(top).Length}자 뷰=[{string.Join(", ", views)}]");
                }
            }
            Directory.CreateDirectory(Path.GetDirectoryName(DiagnosePath)!);
            var kept = File.Exists(DiagnosePath) ? File.ReadAllLines(DiagnosePath).TakeLast(300 - lines.Count) : Enumerable.Empty<string>();
            File.WriteAllLines(DiagnosePath, kept.Concat(lines).ToList());
        }
        catch { /* diagnostics only */ }
    }

    static KakaoWindow? FromMain(IntPtr main)
    {
        IntPtr online = 0, locked = 0, contactView = 0, contactList = 0, chatView = 0, searchEdit = 0, searchList = 0;
        foreach (var child in Native.ChildWindows(main))
        {
            var name = Native.WindowText(child);
            if (name.StartsWith("OnlineMainView_")) online = child;
            else if (name.StartsWith("LockModeView_")) locked = child;
            else if (name.StartsWith("ContactListView_")) contactView = child;
            else if (name.StartsWith("ContactListCtrl_")) contactList = child;
            else if (name.StartsWith("ChatRoomListView_")) chatView = child;
        }
        if (online == 0 && locked == 0) return null;
        if (contactView != 0)
            foreach (var child in Native.ChildWindows(contactView))
            {
                if (Native.GetParent(child) != contactView) continue;
                if (Native.ClassName(child) == "Edit") searchEdit = child;
                else if (Native.WindowText(child).StartsWith("SearchListCtrl_")) searchList = child;
            }
        Native.GetWindowThreadProcessId(main, out var pid);
        return new KakaoWindow
        {
            Main = main, OnlineView = online, LockView = locked,
            ContactView = contactView, ContactList = contactList, ChatRoomView = chatView,
            FriendSearchEdit = searchEdit, FriendSearchList = searchList, ProcessId = pid,
        };
    }

    public bool MainShown => Native.IsWindowVisible(Main) && !Native.IsIconic(Main);

    public bool Ready => Native.IsWindow(Main)
        && OnlineView != IntPtr.Zero && Native.HasVisibleStyle(OnlineView)
        && !(LockView != IntPtr.Zero && Native.HasVisibleStyle(LockView));

    /// <summary>True when the friend tab (not the chat or more tab) is the selected view.</summary>
    public bool FriendTabSelected => ContactView != IntPtr.Zero && Native.HasVisibleStyle(ContactView);

    public bool ChatTabSelected => ChatRoomView != IntPtr.Zero && Native.HasVisibleStyle(ChatRoomView);
}
