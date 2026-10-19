using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace NineTalkDaemon;

/// <summary>
/// Korean text-line recognizer: PaddleOCR korean_PP-OCRv5_mobile_rec run with ONNX Runtime
/// (Models/korean/rec.onnx + dict.txt). Only recognition: the daemon already knows where each name
/// line is, so PaddleOCR's text detector is not needed. Much better than Windows OCR on KakaoTalk's
/// small bold Hangul (README, "이름 인식").
/// </summary>
sealed class PaddleRec : IDisposable
{
    static readonly Lazy<PaddleRec?> shared = new(TryLoad);

    /// <summary>The loaded recognizer, or null when the model files are missing or fail to load.</summary>
    public static PaddleRec? Shared => shared.Value;
    public static string? LoadError { get; private set; }

    readonly InferenceSession session;
    readonly string inputName;
    readonly int height;
    readonly string[] classes; // CTC classes: [blank, dict..., space]
    readonly object gate = new();

    PaddleRec(string dir)
    {
        session = new InferenceSession(Path.Combine(dir, "rec.onnx"));
        var input = session.InputMetadata.First();
        inputName = input.Key;
        var dims = input.Value.Dimensions; // [batch, 3, H, W]; H may be fixed, W dynamic
        height = dims.Length == 4 && dims[2] > 0 ? dims[2] : 48;
        var dict = File.ReadAllLines(Path.Combine(dir, "dict.txt"));
        classes = new[] { "" }.Concat(dict).Append(" ").ToArray();
    }

    static PaddleRec? TryLoad()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "Models", "korean");
        try { return new PaddleRec(dir); }
        catch (Exception ex) { LoadError = ex.Message; return null; }
    }

    public string Describe() => $"PaddleOCR korean rec: input height {height}, classes {classes.Length}";

    /// <summary>Recognizes one text line in <paramref name="region"/> of the image. Returns the text and its mean character confidence.</summary>
    public (string Text, float Confidence) Recognize(Bitmap source, Rectangle region)
    {
        region.Intersect(new Rectangle(Point.Empty, source.Size));
        if (region.Width <= 0 || region.Height <= 0) return ("", 0);

        int width = Math.Max(height, (int)Math.Ceiling(region.Width * (double)height / region.Height));
        using var line = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(line))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.DrawImage(source, new Rectangle(0, 0, width, height), region, GraphicsUnit.Pixel);
        }

        // NCHW float, BGR order as PaddleOCR reads images (OpenCV), normalized to [-1, 1].
        var tensor = new DenseTensor<float>(new[] { 1, 3, height, width });
        var data = line.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var row = new byte[width * 4];
            for (int y = 0; y < height; y++)
            {
                Marshal.Copy(data.Scan0 + y * data.Stride, row, 0, row.Length);
                for (int x = 0; x < width; x++)
                {
                    // Memory order of Format32bppArgb is B, G, R, A.
                    tensor[0, 0, y, x] = row[x * 4 + 0] / 127.5f - 1f;
                    tensor[0, 1, y, x] = row[x * 4 + 1] / 127.5f - 1f;
                    tensor[0, 2, y, x] = row[x * 4 + 2] / 127.5f - 1f;
                }
            }
        }
        finally { line.UnlockBits(data); }

        float[] output;
        int steps, numClasses;
        lock (gate)
        {
            using var results = session.Run(new[] { NamedOnnxValue.CreateFromTensor(inputName, tensor) });
            var probs = results.First().AsTensor<float>();
            steps = probs.Dimensions[1];
            numClasses = probs.Dimensions[2];
            output = probs.ToArray();
        }

        // Greedy CTC decoding: best class per step, drop blanks (0) and repeats.
        var text = new System.Text.StringBuilder();
        float confSum = 0;
        int kept = 0, previous = -1;
        for (int t = 0; t < steps; t++)
        {
            int best = 0;
            float bestP = float.MinValue;
            for (int c = 0; c < numClasses; c++)
            {
                var p = output[t * numClasses + c];
                if (p > bestP) { bestP = p; best = c; }
            }
            if (best != 0 && best != previous && best < classes.Length)
            {
                text.Append(classes[best]);
                confSum += bestP;
                kept++;
            }
            previous = best;
        }
        return (text.ToString().Trim(), kept == 0 ? 0 : confSum / kept);
    }

    public void Dispose() => session.Dispose();
}
