using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace NineTalkDaemon;

/// <summary>
/// Reads friend names from the PC KakaoTalk friend tab with screen capture (PrintWindow) + OCR.
///
/// The friend list is a custom-drawn EVA_VH_ListControl: UI Automation, MSAA and window text expose
/// only the window itself, never the rows, so the pixels are the only source of names.
///
/// Window operations are limited to what reading needs: show the main window without activating it,
/// click the friend tab icon in the left bar, and post mouse-wheel messages to the friend list.
/// Nothing is ever clicked inside the list and no key (Enter included) is sent, so no chat opens.
/// Everything is put back afterwards (tab and hidden/minimized state).
/// </summary>
static class FriendListReader
{
    // Layout of KakaoTalk 26.8 at 100% scaling; multiplied by the window DPI scale.
    internal const int TabX = 32, FriendTabY = 27, ChatTabY = 87; // left-bar icons, OnlineMainView client coords
    const int ScrollbarWidth = 14;
    const int AvatarLeft = 20, AvatarRight = 56, AvatarSize = 40;
    const int MinAvatar = 28, MaxAvatar = 48;            // my profile is taller, header text is shorter
    const int RowPitch = 56;                              // friend rows, with or without a status message
    const int NameLeft = 64;
    const int HeaderMaxLeft = 40, HeaderMaxHeight = 16;
    const int WheelNotches = 4;                           // ~90px per notch: keeps overlap with a ~580px list
    const int MaxPages = 3000;

    sealed record Band(int Top, int Bottom);
    sealed record Header(int Top, string Text, bool IsFriends);

    sealed class Page
    {
        public required Bitmap Image { get; init; }
        public required double Scale { get; init; }
        public required int[] Pixels { get; init; }
        public required ulong[] RowHash { get; init; }
        public required bool[] RowInformative { get; init; }
        public required List<Band> Avatars { get; init; }
        public required List<Header> Headers { get; init; }
        public int Width => Image.Width;
        public int Height => Image.Height;
    }

    /// <summary>
    /// Turns a sequence of list captures (top to bottom, each scrolled less than one screen) into names.
    /// Positions are tracked in list coordinates (page offset = sum of the measured scroll shifts), and
    /// friend rows sit on a fixed pitch below the "친구 N" header, so row k is read exactly once from the
    /// first page that shows it whole. Two different friends with the same name are both kept.
    /// </summary>
    sealed class ReadSession(double scale, Action<FriendName> onName, Action<string> log) : IDisposable
    {
        Page? prev;
        int pageNo, offset, nextRow, total, unreadable, uncertain, stuck;
        int? firstRow; // list y of the first friend row's avatar top
        int? expected; // count shown in the "친구 N" header

        int S(int v) => (int)Math.Round(v * scale);

        /// <summary>Returns false when there is nothing more to read (all rows read, or the list ended).</summary>
        public async Task<bool> AddPageAsync(Bitmap image)
        {
            var page = await AnalyzeAsync(image, scale);
            int? shift = null;
            if (prev is not null)
            {
                shift = FindShift(prev, page);
                if (shift == 0)
                {
                    page.Image.Dispose();
                    // Fewer rows than KakaoTalk's count: the wheel may just have been missed while it was busy,
                    // so scroll a few more times before calling it the bottom.
                    if (expected is int e && nextRow < e && ++stuck <= 3)
                    {
                        log($"  목록이 안 움직임 ({nextRow}/{e}행), 다시 내려 봄");
                        return true;
                    }
                    return false; // the list did not move: bottom reached
                }
                stuck = 0;
                if (shift is null) { page.Image.Dispose(); throw new ShiftLostException(); }
                offset += shift.Value;
            }
            prev?.Image.Dispose();
            prev = page;
            log($"page {pageNo++}: shift={shift?.ToString() ?? "-"} offset={offset} avatars={page.Avatars.Count} headers=[{string.Join(", ", page.Headers.Select(h => $"{h.Top}:{h.Text}"))}]");

            if (firstRow is null)
            {
                var header = page.Headers.FirstOrDefault(h => h.IsFriends);
                var first = header is null ? null : page.Avatars.FirstOrDefault(a => a.Top > header.Top);
                if (first is null || first.Bottom > page.Height - 2) return true; // not on screen yet
                firstRow = offset + first.Top;
                // "친구 1,234": a thousands separator must not cut the count to 1.
                var digits = Regex.Match(header!.Text, @"\d[\d,.]*");
                if (digits.Success && int.TryParse(digits.Value.Replace(",", "").Replace(".", ""), out var n)) expected = n;
            }

            // Rows that are whole on this page and not read yet.
            // The "친구 N" count is OCR too and can be misread (433 → 43), so it never ends the read by
            // itself: before N an empty row is a row we failed to read, from N on it is the end of the list.
            var rows = new List<(int index, Band band)>();
            bool ended = false;
            while (true)
            {
                int top = firstRow.Value + nextRow * S(RowPitch) - offset;
                // Snap to the detected avatar, so rounding never accumulates over hundreds of rows.
                var snapped = page.Avatars.FirstOrDefault(a => Math.Abs(a.Top - top) <= S(6));
                if (snapped is not null && snapped.Top != top)
                {
                    firstRow += snapped.Top - top;
                    top = snapped.Top;
                }
                if (top + S(AvatarSize) > page.Height - 2) break; // not whole yet: next page
                bool pastCount = expected is int count && nextRow >= count;
                // A section header in this slot after the count: the friends section is over.
                if (pastCount && page.Headers.Any(h => h.Top >= top - S(8) && h.Top < top + S(AvatarSize))) { ended = true; break; }
                // A very light profile picture can miss the avatar check; a name in the row still counts.
                if (!HasAvatar(page, top) && NameBox(page, new Band(top, top + S(AvatarSize)), S(NameLeft)) is null)
                {
                    if (expected is null || pastCount) { ended = true; break; } // an empty row is the end
                    unreadable++;
                    log($"  #{nextRow + 1}: 행을 찾지 못함 (y={top})");
                    nextRow++;
                    continue;
                }
                if (pastCount && nextRow == expected)
                    log($"  카카오톡 표시 {expected}명보다 친구가 더 있습니다 (제목 숫자를 잘못 읽었을 수 있음). 목록 끝까지 읽습니다.");
                rows.Add((nextRow++, new Band(top, top + S(AvatarSize))));
            }

            var names = await ReadNamesAsync(page, rows.Select(r => r.band).ToList(), S(NameLeft));
            for (int i = 0; i < rows.Count; i++)
            {
                var (name, readings) = names[i];
                var label = $"  #{rows[i].index + 1} y={rows[i].band.Top}:";
                if (name is null) { unreadable++; log($"{label} 이름을 읽지 못함 {readings}"); continue; }
                total++;
                if (name.Uncertain) uncertain++;
                var showReadings = name.Uncertain || Environment.GetEnvironmentVariable("NINETALK_OCR_COMPARE") == "1";
                log($"{label} {name.Name}{(name.Uncertain ? "  (?)" : "")}{(showReadings ? " " + readings : "")}");
                onName(name);
            }
            return !ended;
        }

        public ReadSummary Finish()
        {
            log($"읽은 친구 {total}명" + (expected is int e ? $" / 카카오톡 표시 {e}명" : "")
                + (uncertain > 0 ? $", 인식 불확실 {uncertain}명" : "") + (unreadable > 0 ? $", 읽지 못한 행 {unreadable}개" : ""));
            return new ReadSummary(total, expected, unreadable, uncertain);
        }

        public void Dispose() => prev?.Image.Dispose();
    }

    /// <summary>Debug entry (--replay dir): runs the reader over page-*.png saved by NINETALK_DEBUG_DIR.</summary>
    public static async Task<string> ReplayAsync(string dir)
    {
        var sb = new System.Text.StringBuilder();
        using var session = new ReadSession(1.0, _ => { }, line => sb.AppendLine(line));
        foreach (var file in Directory.GetFiles(dir, "page-*.png").Order())
            if (!await session.AddPageAsync(new Bitmap(file))) break;
        session.Finish();
        return sb.ToString();
    }

    public static async Task<ReadSummary> ReadAsync(KakaoWindow kakao, Action<FriendName> onName, CancellationToken ct, Action<string> log)
    {
        var debugDir = Environment.GetEnvironmentVariable("NINETALK_DEBUG_DIR");
        if (!string.IsNullOrEmpty(debugDir)) Directory.CreateDirectory(debugDir);
        var s = Native.GetDpiForWindow(kakao.Main) / 96.0;
        int S(int v) => (int)Math.Round(v * s);

        bool wasShown = kakao.MainShown, wasIconic = Native.IsIconic(kakao.Main);
        bool wasFriendTab = kakao.FriendTabSelected, wasChatTab = kakao.ChatTabSelected;
        var session = new ReadSession(s, onName, log);
        try
        {
            if (!wasShown)
            {
                Native.ShowWindow(kakao.Main, Native.SW_SHOWNOACTIVATE);
                await Task.Delay(400, ct);
            }
            if (!wasFriendTab)
            {
                Click(kakao.OnlineView, S(TabX), S(FriendTabY));
                await Task.Delay(400, ct);
                if (!kakao.FriendTabSelected) throw new InvalidOperationException("카카오톡 친구 탭으로 바꾸지 못했습니다.");
            }

            await ScrollToTopAsync(kakao, ct);

            for (int pageNo = 0; pageNo < MaxPages; pageNo++)
            {
                ct.ThrowIfCancellationRequested();
                if (!kakao.Ready || !kakao.FriendTabSelected)
                    throw new InvalidOperationException("읽는 도중 카카오톡 화면이 바뀌었습니다 (잠금/탭 이동).");

                var image = await CaptureStableAsync(kakao, ct);
                if (debugDir is { Length: > 0 }) image.Save(Path.Combine(debugDir, $"page-{pageNo:D3}.png"), ImageFormat.Png);
                bool more;
                try { more = await session.AddPageAsync(image); }
                catch (ShiftLostException)
                {
                    // Usually a transient repaint (hover, a new profile badge): capture once more.
                    log("스크롤 위치 다시 맞추는 중");
                    await Task.Delay(400, ct);
                    more = await session.AddPageAsync(await CaptureStableAsync(kakao, ct));
                }
                if (!more) break;

                Wheel(kakao, -120 * WheelNotches);
                await Task.Delay(200, ct);
            }
            return session.Finish();
        }
        finally
        {
            session.Dispose();
            try
            {
                if (!wasFriendTab && wasChatTab) Click(kakao.OnlineView, S(TabX), S(ChatTabY));
                if (!wasShown) Native.ShowWindow(kakao.Main, wasIconic ? Native.SW_SHOWMINNOACTIVE : Native.SW_HIDE);
            }
            catch { /* restoring is best effort */ }
        }
    }

    // ---- window operations -------------------------------------------------

    internal static void Click(IntPtr hwnd, int x, int y)
    {
        var lp = Native.MakeLParam(x, y);
        Native.PostMessage(hwnd, Native.WM_MOUSEMOVE, IntPtr.Zero, lp);
        Native.PostMessage(hwnd, Native.WM_LBUTTONDOWN, (IntPtr)1, lp);
        Native.PostMessage(hwnd, Native.WM_LBUTTONUP, IntPtr.Zero, lp);
    }

    /// <summary>Mouse wheel over the friend list; negative delta scrolls down.</summary>
    static void Wheel(KakaoWindow kakao, int delta)
    {
        var r = Native.WindowRect(kakao.ContactList);
        var lp = Native.MakeLParam(r.Left + r.Width / 2, r.Top + r.Height / 2);
        Native.PostMessage(kakao.ContactList, Native.WM_MOUSEWHEEL, (IntPtr)(delta << 16), lp);
    }

    static async Task ScrollToTopAsync(KakaoWindow kakao, CancellationToken ct)
    {
        ulong[]? last = null;
        for (int i = 0; i < 200; i++)
        {
            Wheel(kakao, 120 * 10);
            await Task.Delay(120, ct);
            using var img = await CaptureStableAsync(kakao, ct);
            var hash = RowHashes(Pixels(img), img.Width, img.Height);
            if (last is not null && hash.AsSpan().SequenceEqual(last)) return;
            last = hash;
        }
    }

    /// <summary>Captures the list until two captures in a row match (KakaoTalk scrolls smoothly).</summary>
    static async Task<Bitmap> CaptureStableAsync(KakaoWindow kakao, CancellationToken ct)
    {
        Bitmap? previous = null;
        for (int i = 0; i < 8; i++)
        {
            var current = Capture.Child(kakao.Main, kakao.ContactList, ScrollbarWidth)
                ?? throw new InvalidOperationException("친구 목록을 캡처하지 못했습니다.");
            if (previous is not null && SamePixels(previous, current)) { previous.Dispose(); return current; }
            previous?.Dispose();
            previous = current;
            await Task.Delay(80, ct);
        }
        return previous!;
    }

    // ---- page analysis -----------------------------------------------------

    /// <summary>Profile pictures in a list capture: rows where the avatar column differs from the row's background (x=4).</summary>
    static List<Band> FindAvatars(int[] px, int w, int h, double s)
    {
        int[] probeX = { (int)((AvatarLeft + 8) * s), (int)((AvatarLeft + AvatarRight) / 2 * s), (int)((AvatarRight - 8) * s) };
        var avatars = new List<Band>();
        int runStart = -1;
        for (int y = 0; y <= h; y++)
        {
            bool ink = y < h && probeX.Any(x => x < w && !Near(px[y * w + x], px[y * w + (int)(4 * s)], 30));
            if (ink && runStart < 0) runStart = y;
            if (!ink && runStart >= 0)
            {
                int len = y - runStart;
                if (len >= MinAvatar * s && len <= MaxAvatar * s) avatars.Add(new Band(runStart, y));
                runStart = -1;
            }
        }
        return avatars;
    }

    /// <summary>How many friend rows a list capture shows (used for the friend search results).</summary>
    public static int CountRows(Bitmap image, double s) => FindAvatars(Pixels(image), image.Width, image.Height, s).Count;

    static async Task<Page> AnalyzeAsync(Bitmap image, double s)
    {
        int w = image.Width, h = image.Height;
        var px = Pixels(image);
        var hashes = RowHashes(px, w, h);
        var informative = new bool[h];
        for (int y = 0; y < h; y++)
        {
            int first = Normalize(px[y * w]), differing = 0;
            for (int x = 1; x < w && differing <= 4; x++) if (!Near(Normalize(px[y * w + x]), first, 8)) differing++;
            informative[y] = differing > 4;
        }

        var avatars = FindAvatars(px, w, h, s);

        // Section headers ("즐겨찾는 친구 11", "친구 428", ...): small text at the left edge, not beside an
        // avatar, ending in the section's count. The count rule keeps OCR noise from photo avatars and
        // the captions under "업데이트한 친구" thumbnails from being taken for a header.
        var headers = new List<Header>();
        foreach (var line in await Ocr.RecognizeAsync(image))
        {
            var b = line.Bounds;
            if (b.Left > HeaderMaxLeft * s || b.Height > HeaderMaxHeight * s) continue;
            if (avatars.Any(a => b.Bottom > a.Top && b.Top < a.Bottom)) continue;
            if (!Regex.IsMatch(line.Text, @"\d+\s*$")) continue;
            headers.Add(new Header(b.Top, line.Text, IsFriendsHeader(line.Text)));
        }
        headers.Sort((a, b) => a.Top.CompareTo(b.Top));

        return new Page { Image = image, Scale = s, Pixels = px, RowHash = hashes, RowInformative = informative, Avatars = avatars, Headers = headers };
    }

    /// <summary>Whether a friend row starts at y: at least a fifth of the avatar box differs from the background.</summary>
    static bool HasAvatar(Page page, int top)
    {
        double s = page.Scale;
        int left = (int)(AvatarLeft * s), right = Math.Min(page.Width, (int)(AvatarRight * s));
        int inked = 0, total = 0;
        for (int y = Math.Max(0, top); y < Math.Min(page.Height, top + (int)(AvatarSize * s)); y += 2)
        {
            int bg = page.Pixels[y * page.Width + 4];
            for (int x = left; x < right; x += 2, total++)
                if (!Near(page.Pixels[y * page.Width + x], bg, 30)) inked++;
        }
        return total > 0 && inked * 5 >= total;
    }

    /// <summary>The main "친구 N" header (OCR often reads 친 as 진): two letters ending in 구, then the count.</summary>
    static bool IsFriendsHeader(string text)
    {
        var letters = new string(text.Where(char.IsLetter).ToArray());
        return letters.Length == 2 && letters[1] == '구';
    }

    /// <summary>Below this mean character confidence a PaddleOCR reading is marked uncertain.</summary>
    const float PaddleMinConfidence = 0.85f;

    /// <summary>
    /// Reads the names beside the given avatars. Uses the PaddleOCR Korean model when it is installed
    /// (Models/korean), otherwise Windows OCR. NINETALK_OCR=windows forces Windows OCR, and
    /// NINETALK_OCR_COMPARE=1 also runs Windows OCR and puts both readings in the log.
    /// </summary>
    static async Task<List<(FriendName? name, string readings)>> ReadNamesAsync(Page page, List<Band> bands, int nameLeft)
    {
        var paddle = Environment.GetEnvironmentVariable("NINETALK_OCR") == "windows" ? null : PaddleRec.Shared;
        if (paddle is null) return await ReadNamesWindowsOcrAsync(page, bands, nameLeft);

        var compare = Environment.GetEnvironmentVariable("NINETALK_OCR_COMPARE") == "1"
            ? await ReadNamesWindowsOcrAsync(page, bands, nameLeft)
            : null;
        var results = new List<(FriendName?, string)>();
        for (int i = 0; i < bands.Count; i++)
        {
            var box = NameBox(page, bands[i], nameLeft);
            if (box is null) { results.Add((null, "[이름 글자 없음]")); continue; }
            var (text, confidence) = paddle.Recognize(page.Image, TightenRight(page, box.Value));
            var debug = $"[paddle {confidence:F2}]" + (compare is null ? "" : $" windows: {compare[i].name?.Name ?? "-"}");
            results.Add(text.Length == 0
                ? (null, debug)
                : (new FriendName(text, Uncertain: confidence < PaddleMinConfidence), debug));
        }
        return results;
    }

    /// <summary>
    /// Cuts the empty space right of the name (the recognizer reads a long blank tail as noise), keeping
    /// a margin. Any non-background pixel counts, so coloured emoji in a name stay inside.
    /// </summary>
    static Rectangle TightenRight(Page page, Rectangle box)
    {
        int lastInk = box.Left;
        for (int y = Math.Max(0, box.Top); y < Math.Min(page.Height, box.Bottom); y++)
        {
            int bg = page.Pixels[y * page.Width + 4];
            for (int x = box.Right - 1; x > lastInk; x--)
                if (!Near(page.Pixels[y * page.Width + x], bg, 40)) { lastInk = x; break; }
        }
        int margin = (int)(8 * page.Scale);
        return Rectangle.FromLTRB(box.Left, box.Top, Math.Min(box.Right, lastInk + margin), box.Bottom);
    }

    /// <summary>
    /// Windows OCR path: OCRs the name beside one avatar at several zoom levels and votes.
    /// Windows OCR misreads small Hangul differently per zoom (김 → "71", "7`"), so disagreement
    /// between readings marks the name as uncertain for the user to check.
    /// </summary>
    static async Task<List<(FriendName? name, string readings)>> ReadNamesWindowsOcrAsync(Page page, List<Band> bands, int nameLeft)
    {
        var results = new List<(FriendName?, string)>();
        if (bands.Count == 0) return results;

        // Windows OCR often returns nothing for a lone short line ("김준수"), but reads the same line
        // inside a block of text. So the name lines of a page are stacked into one image, one per slot.
        var boxes = bands.Select(b => NameBox(page, b, nameLeft)).ToList();
        int slot = (int)(RowPitch * page.Scale);
        int width = Math.Max(1, boxes.Max(b => b?.Width ?? 0));
        int pad = (int)(16 * page.Scale);
        using var stack = new Bitmap(width + pad * 2, slot * bands.Count + pad * 2, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(stack))
        {
            g.Clear(Color.FromArgb(page.Pixels[4]));
            for (int i = 0; i < boxes.Count; i++)
                if (boxes[i] is Rectangle box)
                    g.DrawImage(page.Image, new Rectangle(pad, pad + i * slot + (slot - box.Height) / 2, box.Width, box.Height), box, GraphicsUnit.Pixel);
        }

        var readings = bands.Select(_ => new List<string>()).ToList();
        foreach (var zoom in Zooms)
        {
            var perSlot = bands.Select(_ => new List<OcrLine>()).ToList();
            foreach (var line in await Ocr.RecognizeAsync(stack, zoom))
            {
                int i = (line.Bounds.Top + line.Bounds.Height / 2 - pad) / slot;
                if (i >= 0 && i < perSlot.Count) perSlot[i].Add(line);
            }
            for (int i = 0; i < bands.Count; i++)
                readings[i].Add(string.Join(" ", perSlot[i].OrderBy(l => l.Bounds.Left).Select(l => l.Text.Trim())));
        }

        // Second opinion: each row on its own, at full row height with everything but the name blanked.
        // The two layouts fail on different rows, so together they read more names than either alone.
        for (int i = 0; i < bands.Count; i++)
        {
            if (boxes[i] is not Rectangle box) continue;
            var row = Rectangle.FromLTRB(nameLeft, bands[i].Top - 4, box.Right, bands[i].Bottom + 4);
            foreach (var zoom in Zooms)
                readings[i].Add(string.Join(" ", (await Ocr.RecognizeStripAsync(page.Image, row, zoom, keep: box)).Select(l => l.Text.Trim())));
        }

        for (int i = 0; i < bands.Count; i++)
        {
            var debug = "[" + string.Join(" | ", readings[i]) + "]";
            var votes = readings[i].Where(r => r.Length > 0).GroupBy(r => r.Replace(" ", "")).ToList();
            if (boxes[i] is null || votes.Count == 0) { results.Add((null, debug)); continue; }

            // Misreads usually add stray digits or symbols ("7`다훈" for 김다훈), so a clean Hangul/Latin
            // reading gets a bonus worth one and a half votes; a name that really has symbols ("김서연 :)")
            // still wins when most readings agree on it.
            var best = votes
                .OrderByDescending(g => g.Count() + (Plausibility(g.Key) == 1 ? 1.5 : 0))
                .First();
            // The most common spelling of the winning group keeps the original spacing ("김서연 :)").
            var text = best.GroupBy(r => r).OrderByDescending(g => g.Count()).First().Key;
            // Uncertain unless a clear majority of all readings agree.
            results.Add((new FriendName(text, Uncertain: best.Count() * 2 <= readings[i].Count), debug));
        }
        return results;
    }

    static readonly float[] Zooms = { 2f, 2.5f, 3f, 4f };

    /// <summary>
    /// The name's own line inside a row: the rows of near-black pixels right of the avatar. A status
    /// message below the name is grey and falls outside, so only the name goes to OCR.
    /// </summary>
    static Rectangle? NameBox(Page page, Band band, int nameLeft)
    {
        int first = -1, last = -1;
        int right = page.Width - (int)(4 * page.Scale);
        for (int y = Math.Max(0, band.Top - 4); y < Math.Min(page.Height, band.Bottom + 4); y++)
        {
            for (int x = nameLeft; x < right; x++)
            {
                int p = page.Pixels[y * page.Width + x];
                int lum = (((p >> 16) & 255) * 299 + ((p >> 8) & 255) * 587 + (p & 255) * 114) / 1000;
                if (lum >= NameMaxLuminance) continue;
                if (first < 0) first = y;
                last = y;
                break;
            }
            // Stop at the first gap after the name, so a dark emoji in a status message is not included.
            if (first >= 0 && last < y - (int)(3 * page.Scale)) break;
        }
        if (first < 0) return null;
        int padY = (int)(3 * page.Scale);
        return Rectangle.FromLTRB(nameLeft, first - padY, right, last + 1 + padY);
    }

    const int NameMaxLuminance = 90; // names are drawn near-black, status messages in grey

    /// <summary>Share of characters that are Hangul syllables, Latin letters or spaces.</summary>
    static double Plausibility(string text) =>
        text.Length == 0 ? 0 : (double)text.Count(c => c is >= '가' and <= '힣' || char.IsAsciiLetter(c) || c == ' ') / text.Length;

    /// <summary>
    /// How many pixels the list moved between two captures: the d where new row y equals old row y+d
    /// for nearly all non-blank rows. Null when no offset fits (scrolled past the overlap).
    /// </summary>
    static int? FindShift(Page old, Page cur)
    {
        int h = Math.Min(old.Height, cur.Height);
        int bestD = -1;
        double bestRatio = 0;
        for (int d = 0; d < h; d++)
        {
            int compared = 0, matched = 0;
            for (int y = 0; y + d < h; y++)
            {
                if (!cur.RowInformative[y]) continue;
                compared++;
                if (cur.RowHash[y] == old.RowHash[y + d]) matched++;
            }
            if (compared < 20) break;
            double ratio = (double)matched / compared;
            if (ratio > bestRatio + 1e-9) { bestRatio = ratio; bestD = d; }
        }
        // 0.6, not ~1: the row under the mouse gets a hover background, so a few rows never match.
        return bestRatio >= 0.6 ? bestD : null;
    }

    // ---- pixel helpers -----------------------------------------------------

    static int[] Pixels(Bitmap bmp)
    {
        var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
        var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var px = new int[bmp.Width * bmp.Height];
            for (int y = 0; y < bmp.Height; y++)
                Marshal.Copy(data.Scan0 + y * data.Stride, px, y * bmp.Width, bmp.Width);
            return px;
        }
        finally { bmp.UnlockBits(data); }
    }

    static ulong[] RowHashes(int[] px, int w, int h)
    {
        var hashes = new ulong[h];
        for (int y = 0; y < h; y++)
        {
            ulong hash = 14695981039346656037;
            for (int x = 0; x < w; x++) { hash ^= (uint)Normalize(px[y * w + x]); hash *= 1099511628211; }
            hashes[y] = hash;
        }
        return hashes;
    }

    /// <summary>Light pixels (white background, grey hover highlight) all count as white for row matching.</summary>
    static int Normalize(int p) =>
        ((p >> 16) & 255) >= 225 && ((p >> 8) & 255) >= 225 && (p & 255) >= 225 ? unchecked((int)0xFFFFFFFF) : p;

    internal static bool SamePixels(Bitmap a, Bitmap b) =>
        a.Size == b.Size && Pixels(a).AsSpan().SequenceEqual(Pixels(b));

    static bool Near(int a, int b, int tolerance) =>
        Math.Abs(((a >> 16) & 255) - ((b >> 16) & 255)) <= tolerance
        && Math.Abs(((a >> 8) & 255) - ((b >> 8) & 255)) <= tolerance
        && Math.Abs((a & 255) - (b & 255)) <= tolerance;
}

/// <summary>A friend name read by OCR. Uncertain when the zoom levels did not all agree.</summary>
public sealed record FriendName(string Name, bool Uncertain);

/// <summary>Counts from one read. Expected is the number in KakaoTalk's "친구 N" header, when it was read.</summary>
public sealed record ReadSummary(int Read, int? Expected, int Unreadable, int Uncertain);

sealed class ShiftLostException() : InvalidOperationException("스크롤 전후 화면을 맞추지 못했습니다. 다시 시도해 주세요.");
