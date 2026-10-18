using System.Drawing.Imaging;

namespace NineTalkDaemon;

static class Capture
{
    /// <summary>
    /// Renders a top-level window into a bitmap with PrintWindow, so the window does not have to be
    /// in front of other windows. Returns null if the window has no size.
    /// </summary>
    public static Bitmap? Window(IntPtr hwnd)
    {
        var rect = Native.WindowRect(hwnd);
        if (rect.Width <= 0 || rect.Height <= 0) return null;
        var bmp = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            var hdc = g.GetHdc();
            try { Native.PrintWindow(hwnd, hdc, Native.PW_RENDERFULLCONTENT); }
            finally { g.ReleaseHdc(hdc); }
        }
        return bmp;
    }

    /// <summary>Captures the main window and crops it to a child window's area.</summary>
    public static Bitmap? Child(IntPtr main, IntPtr child, int trimRight = 0)
    {
        using var full = Window(main);
        if (full is null) return null;
        var mainRect = Native.WindowRect(main);
        var childRect = Native.WindowRect(child);
        var crop = new Rectangle(childRect.Left - mainRect.Left, childRect.Top - mainRect.Top, childRect.Width - trimRight, childRect.Height);
        crop.Intersect(new Rectangle(Point.Empty, full.Size));
        if (crop.Width <= 0 || crop.Height <= 0) return null;
        return full.Clone(crop, full.PixelFormat);
    }

    /// <summary>Share of pixels that are not near-black; ~0 means the window rendered nothing.</summary>
    public static double NonBlackRatio(Bitmap bmp)
    {
        int nonBlack = 0, total = 0;
        for (int y = 0; y < bmp.Height; y += 4)
            for (int x = 0; x < bmp.Width; x += 4)
            {
                var c = bmp.GetPixel(x, y);
                total++;
                if (c.R + c.G + c.B > 60) nonBlack++;
            }
        return total == 0 ? 0 : (double)nonBlack / total;
    }
}
