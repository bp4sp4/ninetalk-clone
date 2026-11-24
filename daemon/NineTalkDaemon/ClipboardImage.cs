using System.Drawing.Imaging;

namespace NineTalkDaemon;

/// <summary>
/// Puts images on the clipboard to paste them into a chat, and puts the user's clipboard back afterwards
/// (only if nothing else was copied meanwhile). Clipboard calls need an STA thread and the send loop runs
/// on the thread pool, so every call runs on a short-lived STA thread of its own.
/// </summary>
sealed class ClipboardImage
{
    readonly List<(string format, object data)> saved = new();
    uint ourSequence;
    bool restored;

    ClipboardImage() { }

    /// <summary>Snapshot of what the user has on the clipboard now.</summary>
    public static ClipboardImage Save() => Sta(() =>
    {
        var backup = new ClipboardImage();
        try
        {
            var current = Clipboard.GetDataObject();
            if (current is not null)
                foreach (var format in current.GetFormats(false))
                {
                    try
                    {
                        if (current.GetData(format, false) is object data) backup.saved.Add((format, data));
                    }
                    catch { /* a format that cannot be read back is left out */ }
                }
        }
        catch { /* clipboard busy: nothing to put back */ }
        return backup;
    });

    /// <summary>Whether GDI+ can decode the image (PNG, JPEG, GIF, BMP; not WebP or HEIC).</summary>
    public static bool CanDecode(byte[] image)
    {
        try
        {
            using var ms = new MemoryStream(image);
            using var decoded = Image.FromStream(ms);
            return decoded.Width > 0 && decoded.Height > 0;
        }
        catch { return false; }
    }

    /// <summary>Puts one image on the clipboard as a bitmap and as PNG (keeps transparency for apps that read PNG).</summary>
    public bool Put(byte[] image) => Sta(() =>
    {
        try
        {
            using var ms = new MemoryStream(image);
            using var decoded = Image.FromStream(ms);
            using var bitmap = new Bitmap(decoded);
            using var png = new MemoryStream();
            bitmap.Save(png, ImageFormat.Png);
            var data = new DataObject();
            data.SetData(DataFormats.Bitmap, true, bitmap);
            data.SetData("PNG", false, new MemoryStream(png.ToArray()));
            Clipboard.SetDataObject(data, true, 10, 100); // copy: stays after this thread ends
            ourSequence = Native.GetClipboardSequenceNumber();
            return true;
        }
        catch { return false; }
    });

    /// <summary>
    /// Puts one file on the clipboard the way Explorer's Copy does (a file list plus "copy" as the drop effect),
    /// so pasting it into a chat attaches the file itself.
    /// </summary>
    public bool PutFile(string path) => Sta(() =>
    {
        try
        {
            var data = new DataObject();
            data.SetFileDropList(new System.Collections.Specialized.StringCollection { path });
            data.SetData("Preferred DropEffect", false, new MemoryStream(BitConverter.GetBytes((int)DragDropEffects.Copy)));
            Clipboard.SetDataObject(data, true, 10, 100);
            ourSequence = Native.GetClipboardSequenceNumber();
            return true;
        }
        catch { return false; }
    });

    /// <summary>Puts the saved clipboard back, unless the user copied something after our last image or file.</summary>
    public void Restore()
    {
        if (restored) return;
        restored = true;
        Sta(() =>
        {
            if (ourSequence == 0 || Native.GetClipboardSequenceNumber() != ourSequence) return 0;
            try
            {
                if (saved.Count == 0) { Clipboard.Clear(); return 0; }
                var data = new DataObject();
                foreach (var (format, value) in saved) data.SetData(format, false, value);
                Clipboard.SetDataObject(data, true, 10, 100);
            }
            catch { /* best effort */ }
            return 0;
        });
    }

    static T Sta<T>(Func<T> work)
    {
        T result = default!;
        Exception? error = null;
        var thread = new Thread(() =>
        {
            try { result = work(); }
            catch (Exception ex) { error = ex; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (error is not null) throw error;
        return result;
    }
}
