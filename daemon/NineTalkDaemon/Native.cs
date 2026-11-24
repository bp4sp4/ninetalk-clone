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
    public static void ReplaceText(IntPtr hwnd, string text)
    {
        SendMessage(hwnd, EM_SETSEL, IntPtr.Zero, (IntPtr)(-1));
        SendMessage(hwnd, EM_REPLACESEL, (IntPtr)1, text);
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

}
