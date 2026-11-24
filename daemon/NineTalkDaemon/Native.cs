using System.Runtime.InteropServices;
using System.Text;

namespace NineTalkDaemon;

/// <summary>Win32 calls used to find and read the PC KakaoTalk window.</summary>
static class Native
{
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left, Top, Right, Bottom;
        public readonly int Width => Right - Left;
        public readonly int Height => Bottom - Top;
        public readonly Rectangle ToRectangle() => Rectangle.FromLTRB(Left, Top, Right, Bottom);
    }

    public const int GWL_STYLE = -16;
    public const int WS_VISIBLE = 0x10000000;
    public const uint PW_RENDERFULLCONTENT = 0x2;
    public const uint WM_MOUSEWHEEL = 0x020A;
    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP = 0x0202;
    public const uint WM_MOUSEMOVE = 0x0200;
    public const int SW_HIDE = 0;
    public const int SW_SHOWNOACTIVATE = 4;
    public const int SW_SHOWMINNOACTIVE = 7;

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc f, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, string lParam);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    public const uint WM_SETTEXT = 0x000C;
    public const uint WM_GETTEXTLENGTH = 0x000E;
    public const uint WM_CLOSE = 0x0010;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const int VK_RETURN = 0x0D;

    public static void SetText(IntPtr hwnd, string text) => SendMessage(hwnd, WM_SETTEXT, IntPtr.Zero, text);

    public const uint EM_SETSEL = 0x00B1;
    public const uint EM_REPLACESEL = 0x00C2;

    /// <summary>
    /// Replaces an edit control's text the way a paste does (EM_REPLACESEL), so the owner gets its change
    /// notification. KakaoTalk's chat input shows WM_SETTEXT text but keeps "전송" disabled.
    /// </summary>
    public static void ReplaceText(IntPtr hwnd, string text, bool undoable = true)
    {
        SendMessage(hwnd, EM_SETSEL, IntPtr.Zero, (IntPtr)(-1));
        SendMessage(hwnd, EM_REPLACESEL, (IntPtr)(undoable ? 1 : 0), text);
    }

    /// <summary>Empties an edit control the way a user would, without an undo step that could bring our text back.</summary>
    public static void ClearText(IntPtr hwnd) => ReplaceText(hwnd, "", undoable: false);

    public const uint WM_GETTEXT = 0x000D;
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
    static extern IntPtr SendMessageText(IntPtr hwnd, uint msg, IntPtr wParam, StringBuilder lParam);

    public static string GetText(IntPtr hwnd)
    {
        // The length can be stale (that is why this is read), so the buffer does not trust it.
        var sb = new StringBuilder(Math.Max(4096, TextLength(hwnd) + 1));
        SendMessageText(hwnd, WM_GETTEXT, (IntPtr)sb.Capacity, sb);
        return sb.ToString();
    }

    public static int TextLength(IntPtr hwnd) => (int)SendMessage(hwnd, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);

    public const uint WM_CHAR = 0x0102;

    /// <summary>
    /// Enter as a real key press would arrive: key down and up with the Enter scan code (0x1C) plus the
    /// WM_CHAR in between. KakaoTalk's chat input ignores a bare WM_KEYDOWN without them.
    /// </summary>
    public static void PressEnter(IntPtr hwnd)
    {
        PostMessage(hwnd, WM_KEYDOWN, (IntPtr)VK_RETURN, (IntPtr)0x001C0001);
        PostMessage(hwnd, WM_CHAR, (IntPtr)'\r', (IntPtr)0x001C0001);
        PostMessage(hwnd, WM_KEYUP, (IntPtr)VK_RETURN, unchecked((IntPtr)0xC01C0001));
    }

    public static string WindowText(IntPtr hwnd)
    {
        var sb = new StringBuilder(512);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string ClassName(IntPtr hwnd)
    {
        var sb = new StringBuilder(256);
        GetClassName(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    /// <summary>The window's own WS_VISIBLE bit, regardless of whether its ancestors are shown.</summary>
    public static bool HasVisibleStyle(IntPtr hwnd) => (GetWindowLong(hwnd, GWL_STYLE) & WS_VISIBLE) != 0;

    public static Rectangle WindowRect(IntPtr hwnd) => GetWindowRect(hwnd, out var r) ? r.ToRectangle() : Rectangle.Empty;

    public static List<IntPtr> TopLevelWindows(uint pid)
    {
        var list = new List<IntPtr>();
        EnumWindows((h, _) =>
        {
            GetWindowThreadProcessId(h, out var p);
            if (p == pid) list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static List<IntPtr> ChildWindows(IntPtr parent)
    {
        var list = new List<IntPtr>();
        EnumChildWindows(parent, (h, _) => { list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    public static IntPtr MakeLParam(int lo, int hi) => (IntPtr)((hi << 16) | (lo & 0xFFFF));

    // ---- image sending (KakaoSender.SendImageAsync) ----

    public const uint WM_PASTE = 0x0302;
    public const uint GW_OWNER = 4;
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; public uint lPrivate; }
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool GetKeyboardState(byte[] state);
    [DllImport("user32.dll")] static extern bool SetKeyboardState(byte[] state);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
    const int VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_LWIN = 0x5B, VK_RWIN = 0x5C;
    const int VK_LSHIFT = 0xA0, VK_RSHIFT = 0xA1, VK_LCONTROL = 0xA2, VK_RCONTROL = 0xA3, VK_LMENU = 0xA4, VK_RMENU = 0xA5;

    /// <summary>
    /// Ctrl + a key, posted to one window only: no global keyboard input, so nothing can land in the program
    /// the user is typing in. Posted keys do not change the keyboard state a program reads with GetKeyState,
    /// so Ctrl is set as held in the target thread's state for the moment (by sharing its input state),
    /// then the state is put back. Other modifiers are cleared meanwhile, so a Shift or Alt the user happens
    /// to hold cannot turn this into another shortcut. Runs on its own thread (it needs an input queue).
    /// </summary>
    /// <returns>true when sent, false when it could not be, null when it did not finish in time (may still arrive).</returns>
    public static bool? PostCtrlKey(IntPtr hwnd, byte vk)
    {
        bool done = false;
        int[] modifiers = { VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN, VK_LSHIFT, VK_RSHIFT, VK_LCONTROL, VK_RCONTROL, VK_LMENU, VK_RMENU };
        var thread = new Thread(() =>
        {
            try
            {
                PeekMessage(out _, IntPtr.Zero, 0, 0, 0); // gives this thread an input queue
                uint target = GetWindowThreadProcessId(hwnd, out _);
                uint ours = GetCurrentThreadId();
                if (target == 0 || !AttachThreadInput(ours, target, true)) return;
                try
                {
                    var old = new byte[256];
                    if (!GetKeyboardState(old)) return;
                    var held = (byte[])old.Clone();
                    foreach (var k in modifiers) held[k] = 0;
                    held[VK_CONTROL] = 0x80;
                    held[VK_LCONTROL] = 0x80;
                    SetKeyboardState(held);
                    nint scan = (nint)MapVirtualKey(vk, 0) << 16;
                    PostMessage(hwnd, WM_KEYDOWN, vk, 1 | scan);
                    Thread.Sleep(100); // held until KakaoTalk has read the key
                    PostMessage(hwnd, WM_KEYUP, vk, 1 | scan | unchecked((nint)0xC0000000));
                    Thread.Sleep(30);
                    // Only the modifiers go back to what they were; any other key the user pressed or released
                    // meanwhile keeps its current state instead of being overwritten with an old snapshot.
                    var now = new byte[256];
                    if (GetKeyboardState(now))
                    {
                        foreach (var k in modifiers) now[k] = old[k];
                        SetKeyboardState(now);
                    }
                    else SetKeyboardState(old);
                    done = true;
                }
                finally { AttachThreadInput(ours, target, false); }
            }
            catch { /* reported as not sent; an exception here must not take the program down */ }
        });
        thread.IsBackground = true;
        thread.Start();
        if (!thread.Join(3000)) return null;
        return done;
    }

}
