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

    /// <summary>Finds the main window and judges the login state. Read-only: sends no messages.</summary>
    public static KakaoState Detect(out KakaoWindow? window)
    {
        window = null;
        var processes = Process.GetProcessesByName("KakaoTalk");
        if (processes.Length == 0) return KakaoState.NotRunning;

        foreach (var process in processes)
        {
            foreach (var top in Native.TopLevelWindows((uint)process.Id))
            {
                if (Native.ClassName(top) != MainClass) continue;
                var found = FromMain(top);
                if (found is null) continue;
                window = found;
                if (found.LockView != IntPtr.Zero && Native.HasVisibleStyle(found.LockView)) return KakaoState.Locked;
                if (found.OnlineView != IntPtr.Zero && Native.HasVisibleStyle(found.OnlineView)) return KakaoState.Ready;
                return KakaoState.LoggedOut;
            }
        }
        // The process is up but no window has the logged-in/lock views: login screen (or still starting).
        return KakaoState.LoggedOut;
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
