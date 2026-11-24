using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;

namespace NineTalkDaemon;

public record OcrLine(string Text, Rectangle Bounds);

/// <summary>Windows built-in OCR (Windows.Media.Ocr) with the Korean recognizer.</summary>
static class Ocr
{
    static OcrEngine? engine;

    public static bool KoreanAvailable => OcrEngine.IsLanguageSupported(new Language("ko"));

    static OcrEngine Engine => engine ??= OcrEngine.TryCreateFromLanguage(new Language("ko"))
        ?? throw new InvalidOperationException("Windows 한국어 OCR이 없습니다. 설정 > 시간 및 언어 > 언어에서 한국어를 추가하세요.");

    /// <summary>
    /// OCRs one region on its own, padded with the background colour. Cutting away avatars and
    /// neighbouring rows removes most of the noise that whole-list OCR picks up. When <paramref name="keep"/>
    /// is given, only that part of the region is copied and the rest stays blank: the canvas keeps the
    /// region's size (Windows OCR often returns nothing for a tightly cropped single line).
    /// </summary>
    public static async Task<List<OcrLine>> RecognizeStripAsync(Bitmap source, Rectangle region, float scale = 2f, Rectangle? keep = null, int pad = 12)
    {
        region.Intersect(new Rectangle(Point.Empty, source.Size));
        if (region.Width <= 0 || region.Height <= 0) return new List<OcrLine>();
        var copy = keep is Rectangle k ? Rectangle.Intersect(region, k) : region;
        using var strip = new Bitmap(region.Width + pad * 2, region.Height + pad * 2, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(strip))
        {
            g.Clear(source.GetPixel(region.Left, region.Top));
            g.DrawImage(source, new Rectangle(pad + copy.X - region.X, pad + copy.Y - region.Y, copy.Width, copy.Height), copy, GraphicsUnit.Pixel);
        }
        var lines = await RecognizeAsync(strip, scale);
        // Back to source coordinates.
        return lines.Select(l => l with { Bounds = new Rectangle(l.Bounds.X - pad + region.X, l.Bounds.Y - pad + region.Y, l.Bounds.Width, l.Bounds.Height) })
            .OrderBy(l => l.Bounds.Top).ToList();
    }

    /// <summary>
    /// Recognizes text lines. The image is upscaled first because KakaoTalk's list font is small;
    /// returned bounds are in the original image's coordinates.
    /// </summary>
    public static async Task<List<OcrLine>> RecognizeAsync(Bitmap image, float scale = 2f, bool gray = false)
    {
        var result = await RunAsync(image, scale, gray);
        var lines = new List<OcrLine>();
        foreach (var line in result.Lines)
        {
            if (line.Words.Count == 0) continue;
            double l = double.MaxValue, t = double.MaxValue, r = 0, b = 0;
            foreach (var w in line.Words)
            {
                l = Math.Min(l, w.BoundingRect.Left);
                t = Math.Min(t, w.BoundingRect.Top);
                r = Math.Max(r, w.BoundingRect.Right);
                b = Math.Max(b, w.BoundingRect.Bottom);
            }
            lines.Add(new OcrLine(line.Text, Unscale(l, t, r, b, scale)));
        }
        return lines;
    }

    /// <summary>Like <see cref="RecognizeAsync"/>, one entry per word (two buttons side by side are one OCR line).</summary>
    public static async Task<List<OcrLine>> RecognizeWordsAsync(Bitmap image, float scale = 2f)
    {
        var result = await RunAsync(image, scale, false);
        return result.Lines.SelectMany(line => line.Words)
            .Select(w => new OcrLine(w.Text, Unscale(w.BoundingRect.Left, w.BoundingRect.Top, w.BoundingRect.Right, w.BoundingRect.Bottom, scale)))
            .ToList();
    }

    static Rectangle Unscale(double l, double t, double r, double b, float scale) =>
        Rectangle.FromLTRB((int)(l / scale), (int)(t / scale), (int)Math.Ceiling(r / scale), (int)Math.Ceiling(b / scale));

    static async Task<OcrResult> RunAsync(Bitmap image, float scale, bool gray)
    {
        using var scaled = new Bitmap((int)(image.Width * scale), (int)(image.Height * scale), PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(scaled))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            using var attributes = new ImageAttributes();
            // Luminance only: drops the coloured ClearType fringes around KakaoTalk's text.
            if (gray) attributes.SetColorMatrix(new ColorMatrix(new[]
            {
                new[] { .299f, .299f, .299f, 0, 0 },
                new[] { .587f, .587f, .587f, 0, 0 },
                new[] { .114f, .114f, .114f, 0, 0 },
                new[] { 0f, 0, 0, 1, 0 },
                new[] { 0f, 0, 0, 0, 1 },
            }));
            g.DrawImage(image, new Rectangle(0, 0, scaled.Width, scaled.Height), 0, 0, image.Width, image.Height, GraphicsUnit.Pixel, attributes);
        }

        using var stream = new MemoryStream();
        scaled.Save(stream, ImageFormat.Png);
        stream.Position = 0;
        var decoder = await BitmapDecoder.CreateAsync(stream.AsRandomAccessStream());
        using var software = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        return await Engine.RecognizeAsync(software);
    }
}
