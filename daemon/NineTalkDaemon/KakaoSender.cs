namespace NineTalkDaemon;

/// <summary>
/// Sends one message (text and/or images) to one friend through the PC KakaoTalk window.
///
/// Steps (all Win32 messages, no global keyboard/mouse input):
/// 1. Put the name into the friend tab's search box (WM_SETTEXT) and count the result rows on a capture.
///    0 rows → not_found, 2+ rows → duplicate_name; nothing is opened.
/// 2. Enter in the search box opens the chat with the (single) result.
/// 3. The new chat window's title (GetWindowText) must equal the name exactly, else room_mismatch.
/// 4. The text goes into the chat's RichEdit with EM_REPLACESEL. In dry-run the daemon stops here, clears
///    the input and closes the chat. Otherwise the yellow "전송" button is clicked, and an empty input
///    afterwards confirms the send.
/// 5. Images (if any, before or after the text): each goes on the clipboard and is pasted into the chat;
///    KakaoTalk shows its image-send window, whose yellow "전송" button is clicked (WM_CLOSE in dry-run).
///    Files the same way after the images. See <see cref="SendPastedAsync"/>.
/// 6. The chat window is closed (WM_CLOSE) unless it was already open before. If KakaoTalk asks something
///    instead (an image still uploading), the chat is left open and the question untouched.
///
/// Verified on KakaoTalk 26.8: a real message went out through the "전송" button click. Posted Enter keys
/// do not send, and text set with WM_SETTEXT leaves the button disabled (README, "발송").
/// </summary>
static class KakaoSender
{
    const int SearchCloseX = 295, SearchCloseY = 73; // "X" beside the friend search box, ContactListView coords

    /// <summary>
    /// Returns null when everything went out (or, in dry-run, would have), otherwise an error code. Once a
    /// part has gone out a later failure is "partial_sent", so the dashboard does not send it all again.
    /// </summary>
    public static async Task<string?> SendOneAsync(KakaoWindow kakao, string name, string text, IReadOnlyList<byte[]> images,
        IReadOnlyList<string> filePaths, bool imageFirst, bool dryRun, Action<string> log, CancellationToken ct)
    {
        var s = Native.GetDpiForWindow(kakao.Main) / 96.0;
        int S(int v) => (int)Math.Round(v * s);
        if (kakao.FriendSearchEdit == IntPtr.Zero || kakao.FriendSearchList == IntPtr.Zero)
            throw new InvalidOperationException("카카오톡 친구 검색창을 찾지 못했습니다.");

        if (!kakao.FriendTabSelected)
        {
            FriendListReader.Click(kakao.OnlineView, S(FriendListReader.TabX), S(FriendListReader.FriendTabY));
            await Task.Delay(400, ct);
            if (!kakao.FriendTabSelected) throw new InvalidOperationException("카카오톡 친구 탭으로 바꾸지 못했습니다.");
        }

        try
        {
            // 1. Search and count results.
            Native.SetText(kakao.FriendSearchEdit, name);
            await Task.Delay(700, ct);
            int rows = await CountSearchRowsAsync(kakao, s, ct);
            // KakaoTalk can draw the results late when busy: an empty result is looked at a few more times
            // before the friend counts as not found.
            bool retried = false;
            for (int retry = 0; rows == 0 && retry < 3; retry++)
            {
                retried = true;
                await Task.Delay(500, ct);
                rows = await CountSearchRowsAsync(kakao, s, ct);
            }
            // Results drawn late may also be drawn part by part: a count found on a retry is taken only after one
            // more look, and the larger count wins (one of two same-named friends must never pass as the only one).
            if (retried && rows > 0)
            {
                await Task.Delay(500, ct);
                rows = Math.Max(rows, await CountSearchRowsAsync(kakao, s, ct));
            }
            log($"  검색 결과 {rows}명");
            if (rows == 0) return "not_found";
            if (rows > 1) return "duplicate_name";

            // 2. Open the chat with the single result.
            var before = ChatWindows(kakao).ToHashSet();
            Native.PressEnter(kakao.FriendSearchEdit);
            IntPtr chat = IntPtr.Zero;
            bool openedByUs = false;
            for (int i = 0; i < 30 && chat == IntPtr.Zero; i++)
            {
                await Task.Delay(100, ct);
                var now = ChatWindows(kakao);
                chat = now.FirstOrDefault(h => !before.Contains(h));
                if (chat != IntPtr.Zero) openedByUs = true;
                // Already open before: KakaoTalk only brings it forward, so look it up by title.
                else if (i >= 10) chat = now.FirstOrDefault(h => Native.WindowText(h) == name);
            }
            if (chat == IntPtr.Zero) return "send_failed";

            try
            {
                // 3. Exact title check.
                var title = Native.WindowText(chat);
                log($"  채팅창 0x{chat:X} {Native.ClassName(chat)} (새로 열림: {openedByUs}), 자식: "
                    + string.Join(", ", Native.ChildWindows(chat).Select(h => Native.ClassName(h)).Distinct()));
                if (title != name)
                {
                    log($"  채팅방 제목이 이름과 다름 (제목 {title.Length}자, 이름 {name.Length}자)");
                    return "room_mismatch";
                }

                var input = Native.ChildWindows(chat).FirstOrDefault(h => Native.ClassName(h).StartsWith("RICHEDIT", StringComparison.OrdinalIgnoreCase));
                if (input == IntPtr.Zero) { log("  입력창을 찾지 못함"); return "send_failed"; }
                // Someone's unsent draft: never overwrite it or send it along.
                // A length of 0 is surely empty. A length above 0 may be stale: WM_GETTEXTLENGTH has reported the
                // last sent text after a send, which would stop every send here. So then the yellow "전송" button
                // decides (KakaoTalk lights it only while its input holds text), watched for about a second in case
                // a draft is drawn late. A failed capture stops the send: never overwrite what we could not see.
                // What the box held when its length was above 0 but the button stayed grey. Put back if the button
                // then never lights for our text either: on such a PC the button check does not work (another
                // theme or scaling), so that may have been a real draft we could not see.
                string? unconfirmed = null;
                if (Native.TextLength(input) > 0)
                {
                    for (int i = 0; i < 6; i++)
                    {
                        await Task.Delay(200, ct);
                        var lit = SendButtonLit(chat);
                        if (lit is null) { log("  채팅창을 캡처하지 못해 입력창을 확인할 수 없음"); return "send_failed"; }
                        if (lit == true) { log("  입력창에 쓰던 글이 있어 건드리지 않음 (전송 버튼이 켜져 있음)"); return "input_not_empty"; }
                    }
                    log($"  입력창 글자 수 {Native.TextLength(input)} 이지만 전송 버튼이 꺼져 있어 빈 것으로 봄");
                    unconfirmed = Native.GetText(input);
                }
                // The button never lit for our text: the box is put back as it was (see unconfirmed above).
                void PutBack()
                {
                    if (unconfirmed is { Length: > 0 })
                    {
                        Native.ReplaceText(input, unconfirmed, undoable: false);
                        log("  전송 버튼을 알아보지 못해 입력창을 원래대로 되돌림");
                    }
                    else Native.ClearText(input);
                }

                int sentSteps = 0;
                string Failed(string detail)
                {
                    log("  실패: " + detail);
                    return sentSteps > 0 ? "partial_sent" : "send_failed";
                }

                async Task<string?> TextStep()
                {
                    // Text into the input, then the yellow "전송" button. From here on no wait can be cancelled,
                    // so the box is always sent, put back or cleared, never left holding our text.
                    Native.ReplaceText(input, text);
                    await Task.Delay(300, CancellationToken.None);
                    if (Native.TextLength(input) == 0) { PutBack(); return Failed("입력창에 문구가 들어가지 않음"); }

                    // It turns yellow only once KakaoTalk has registered the text, which doubles as a check
                    // that the text really went in.
                    Point? button = null;
                    for (int i = 0; i < 10 && button is null; i++)
                    {
                        button = FindSendButton(chat);
                        if (button is null) await Task.Delay(150, CancellationToken.None);
                    }
                    log(button is Point p ? $"  전송 버튼 {p.X},{p.Y} (채팅창 기준)" : "  전송 버튼을 찾지 못함");

                    if (dryRun)
                    {
                        log("  [dry-run] 입력창에 넣기까지만 하고 보내지 않음");
                        SaveInputArea(chat, input, log);
                        await Task.Delay(1500, CancellationToken.None); // time to look at it
                        if (button is null) { PutBack(); return Failed("전송 버튼 없음"); }
                        Native.ClearText(input);
                        return null;
                    }
                    if (button is not Point click) { PutBack(); return Failed("전송 버튼 없음"); }

                    FriendListReader.Click(chat, click.X, click.Y);
                    // Sent = the button went back to grey (KakaoTalk emptied its input). WM_GETTEXTLENGTH is not
                    // used: on a real send it still reported the old text, which once turned a sent message
                    // into send_failed.
                    for (int i = 0; i < 25; i++)
                    {
                        await Task.Delay(200, CancellationToken.None); // never abandon a send half-way
                        if (FindSendButton(chat) is null) { sentSteps++; return null; }
                    }
                    Native.ClearText(input);
                    return Failed("전송 버튼을 누른 뒤에도 버튼이 활성 상태로 남음");
                }

                // Images first, then files, each pasted on its own.
                var pastes = images.Select(ImagePaste).Concat(filePaths.Select(FilePaste)).ToList();
                var clipboard = pastes.Count > 0 ? ClipboardImage.Save() : null;
                try
                {
                    var steps = new List<Func<Task<string?>>>();
                    if (!imageFirst && text.Length > 0) steps.Add(TextStep);
                    for (int n = 0; n < pastes.Count; n++)
                    {
                        var item = pastes[n];
                        var label = $"{item.What} {pastes.Take(n + 1).Count(p => p.What == item.What)}";
                        steps.Add(async () =>
                        {
                            if (dryRun && item.FileName is not null)
                            {
                                // KakaoTalk may send a pasted file at once, without a window to cancel: a dry-run
                                // must never paste one.
                                log($"  [dry-run] {label}: 파일은 바로 보내질 수 있어 붙여넣지 않음");
                                return null;
                            }
                            var (problem, unsure) = await SendPastedAsync(kakao, chat, input, item, clipboard!, dryRun, log);
                            if (problem is not null && unsure)
                            {
                                // Whether it went out is unknown (a window left over, or a file with no window):
                                // it must not be offered for sending again.
                                log($"  {label}: {problem} (보냈는지 알 수 없음)");
                                return "unknown_result";
                            }
                            // A file step fails the same way for everyone (the window is the same each time):
                            // "_stop" tells the job to stop instead of sending everyone the text without the file.
                            if (problem is not null) return Failed($"{label}: {problem}") + (item.FileName is not null ? StopSuffix : "");
                            if (!dryRun) sentSteps++;
                            return null;
                        });
                    }
                    if (imageFirst && text.Length > 0) steps.Add(TextStep);
                    try
                    {
                        foreach (var step in steps)
                            if (await step() is string error) return error;
                    }
                    catch (Exception ex) when (sentSteps > 0)
                    {
                        // Part of it already went out: never let it be recorded as a plain failure (sent again).
                        log("  일부 보낸 뒤 오류: " + ex.Message);
                        return "partial_sent";
                    }
                    return null;
                }
                finally { clipboard?.Restore(); }
            }
            finally
            {
                // 6. Close what we opened.
                if (openedByUs) await CloseChatAsync(kakao, chat, log);
                await Task.Delay(300, CancellationToken.None);
            }
        }
        finally
        {
            Native.SetText(kakao.FriendSearchEdit, "");
            FriendListReader.Click(kakao.ContactView, S(SearchCloseX), S(SearchCloseY));
        }
    }

    /// <summary>Added to an error code when the whole job should stop (SendService strips it).</summary>
    public const string StopSuffix = "_stop";

    /// <summary>One thing to paste into the chat: an image or a file.</summary>
    sealed record Pasted(string What, Func<ClipboardImage, bool> Put, long Size, int MaxUploadWaitMs, string? FileName);

    static Pasted ImagePaste(byte[] image) => new("이미지", clipboard => clipboard.Put(image), image.Length, 60000, null);
    static Pasted FilePaste(string path) =>
        new("파일", clipboard => clipboard.PutFile(path), new FileInfo(path).Length, 120000, Path.GetFileName(path));

    /// <summary>
    /// Pastes one image or file into the chat and sends it from the window KakaoTalk shows for it. Returns null
    /// when it went out (dry-run: when the window appeared and was cancelled), otherwise what went wrong;
    /// `unsure` means it is unknown whether something went out (a window we could not close is left over, or,
    /// for a file, no window appeared and nothing shows the paste was refused).
    ///
    /// 1. It goes on the clipboard (an image as a bitmap, a file the way Explorer copies one) and Ctrl+V is
    ///    posted to the chat input only (Native.PostCtrlKey).
    ///    No global key input: a real Ctrl+V could land in whatever program the user is typing in.
    /// 2. The image-send window is a new window owned by this chat, or the only new one sitting over the chat
    ///    with a preview's size, so a message notification popping up meanwhile is not clicked. Its yellow
    ///    "전송" button is found on a capture and clicked; the window closing means it was sent.
    /// 3. The upload is given time before moving on (closing the chat during an upload drops the image);
    ///    KakaoTalk shows no progress that can be read, so the wait grows with the image size.
    /// </summary>
    static async Task<(string? problem, bool unsure)> SendPastedAsync(KakaoWindow kakao, IntPtr chat, IntPtr input, Pasted item,
        ClipboardImage clipboard, bool dryRun, Action<string> log)
    {
        var ct = CancellationToken.None; // a paste in flight is always finished or cancelled, never abandoned
        var what = item.What;
        if (!item.Put(clipboard)) return ($"클립보드에 {what}을 넣지 못함", false);

        var before = KakaoWindows(kakao).ToHashSet();
        List<IntPtr> Fresh() => KakaoWindows(kakao).Where(h => !before.Contains(h) && h != chat).ToList();
        var chatRect = Native.WindowRect(chat);
        // The image window: a new window owned by this chat, or else the only new window, sitting over the
        // chat and big enough for a preview (a message notification pops up small, at the screen corner).
        IntPtr? FindSheet()
        {
            var fresh = Fresh();
            var owned = fresh.Where(h => Native.GetWindow(h, Native.GW_OWNER) == chat).ToList();
            if (owned.Count == 1) return owned[0];
            if (owned.Count > 1 || fresh.Count != 1) return null;
            var r = Native.WindowRect(fresh[0]);
            var center = new Point(r.Left + r.Width / 2, r.Top + r.Height / 2);
            return chatRect.Contains(center) && r.Width >= 200 && r.Height >= 150 ? fresh[0] : null;
        }

        // Ctrl+V to the chat input only (WM_PASTE alone opened nothing on KakaoTalk 26.8, 2026-11-24).
        // false: nothing was sent. null (did not finish in time): it may still arrive, so watch for the window as usual.
        if (Native.PostCtrlKey(input, 0x56 /* V */) == false) return ("붙여넣기 키를 보내지 못함", false);
        var sheet = await WaitForAsync<IntPtr>(8000, FindSheet); // a large image takes a while to preview
        if (sheet is not IntPtr window)
        {
            // Nothing we recognise. Close whatever appeared after the paste: an image window we did not
            // recognise must not stay open for a stray Enter to send (closing a notification does no harm).
            var leftovers = Fresh();
            foreach (var h in leftovers)
            {
                var r = Native.WindowRect(h);
                log($"  붙여넣은 뒤 뜬 창 0x{h:X} {Native.ClassName(h)} 제목 {Native.WindowText(h).Length}자 {r.Width}x{r.Height}, 소유 창 0x{Native.GetWindow(h, Native.GW_OWNER):X} → 닫음");
                Native.PostMessage(h, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            }
            bool leftOpen = leftovers.Count > 0
                && await WaitForAsync(3000, () => leftovers.Any(h => Native.IsWindow(h) && Native.IsWindowVisible(h)) ? null : (bool?)true) is null;
            // The key may have arrived as a plain "v" ("ㅍ" in Korean input), or the image went into the box as one
            // embedded object. Cleared only when the box now holds exactly one character and the button lit up:
            // anything longer could be a draft drawn late or something the user typed, and is left alone.
            // A file may also have gone in as its path or name: that text is ours too.
            bool landedInBox = false;
            if (SendButtonLit(chat) == true)
            {
                var boxText = Native.GetText(input);
                if (boxText.Length == 1 || item.FileName is { Length: > 0 } name && boxText.Contains(name, StringComparison.OrdinalIgnoreCase))
                {
                    log("  붙여넣기가 입력창에 글자로 들어가 지움");
                    Native.ClearText(input);
                    landedInBox = true;
                }
                else log("  붙여넣은 뒤 입력창에 글이 있어 그대로 둠");
            }
            if (leftOpen) return ("붙여넣은 뒤 뜬 창이 닫히지 않음", true);
            // An image always gets a window first. A file might be sent straight away without one, so no window
            // (and no text in the box) leaves it unknown whether it went out: never offered for sending again.
            if (item.FileName is not null && !landedInBox) return ($"{what} 전송 창이 뜨지 않음 (바로 보내졌을 수 있음)", true);
            return ($"{what} 전송 창이 뜨지 않음", false);
        }
        var rect = Native.WindowRect(window);
        log($"  {what} 창 0x{window:X} {Native.ClassName(window)} 제목 {Native.WindowText(window).Length}자 {rect.Width}x{rect.Height}, 소유 창 0x{Native.GetWindow(window, Native.GW_OWNER):X}");

        if (dryRun)
        {
            await Task.Delay(1000, ct); // time to look at it
            return await CancelSheetAsync(window) ? (null, false) : ($"{what} 창이 닫히지 않음", true);
        }

        Point? button = null;
        for (int i = 0; i < 10 && button is null; i++)
        {
            button = FindSheetSendButton(window);
            if (button is null) await Task.Delay(150, ct);
        }
        if (button is not Point click)
            return ($"{what} 창의 전송 버튼을 찾지 못함", !await CancelSheetAsync(window));
        log($"  {what} 전송 버튼 {click.X},{click.Y}");
        // The file window has not been seen yet, and a "취소" or "확인" button would look the same to the finder:
        // read the label first and press only "전송".
        if (item.FileName is not null && !await LabelSaysSend(window, click, log))
            return ("파일 창의 버튼 글자가 \"전송\"이 아님", !await CancelSheetAsync(window));
        FriendListReader.Click(window, click.X, click.Y);
        if (await WaitForAsync(8000, () => Native.IsWindow(window) && Native.IsWindowVisible(window) ? null : (bool?)true) is null)
        {
            // Still open after the click. Cancel so it does not stay for a stray Enter to send, but the click may
            // already have sent it (KakaoTalk closing the window late), so the outcome is unknown either way.
            await CancelSheetAsync(window);
            return ($"전송 버튼을 눌러도 {what} 창이 남음", true);
        }
        var wait = (int)Math.Min(item.MaxUploadWaitMs, 3000 + item.Size / 150); // ~150 KB/s
        log($"  {what} 보냄, 업로드 {wait / 1000.0:F1}초 기다림");
        await Task.Delay(wait, ct);
        return (null, false);
    }

    /// <summary>Reads the label around a point (client coordinates) of a window with Windows OCR: is it "전송"?</summary>
    static async Task<bool> LabelSaysSend(IntPtr window, Point clientPoint, Action<string> log)
    {
        try
        {
            using var img = Capture.Window(window);
            if (img is null) return false;
            var s = Native.GetDpiForWindow(window) / 96.0;
            var rect = Native.WindowRect(window);
            var pt = new Native.POINT { X = clientPoint.X, Y = clientPoint.Y };
            Native.ClientToScreen(window, ref pt);
            int x = pt.X - rect.Left, y = pt.Y - rect.Top; // capture coordinates
            var region = new Rectangle(x - (int)(60 * s), y - (int)(18 * s), (int)(120 * s), (int)(36 * s));
            var lines = await Ocr.RecognizeStripAsync(img, region, 3f);
            log($"  버튼 주변 글자: {string.Join(" | ", lines.Select(l => $"'{l.Text}'"))}");
            // Only the line under (or nearest to) the click point counts, so "전송" beside a "취소" being clicked
            // does not pass; and a line that also says 취소/확인/닫기 is never taken.
            var under = lines.OrderBy(l =>
            {
                int dx = Math.Max(0, Math.Max(l.Bounds.Left - x, x - l.Bounds.Right));
                int dy = Math.Max(0, Math.Max(l.Bounds.Top - y, y - l.Bounds.Bottom));
                return dx * dx + dy * dy;
            }).FirstOrDefault();
            if (under is null) return false;
            var text = under.Text.Replace(" ", "");
            if (text.Contains("취소") || text.Contains("확인") || text.Contains("닫기")) return false;
            return text.Contains("전송") || text.Contains("보내기");
        }
        catch (Exception ex)
        {
            log("  버튼 글자를 읽지 못함: " + ex.Message);
            return false;
        }
    }

    /// <summary>Closes the image-send window without sending (its own close = 취소). False if it stays open.</summary>
    static async Task<bool> CancelSheetAsync(IntPtr sheet)
    {
        Native.PostMessage(sheet, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        return await WaitForAsync(3000, () => Native.IsWindow(sheet) && Native.IsWindowVisible(sheet) ? null : (bool?)true) is not null;
    }

    /// <summary>
    /// Closes a chat this run opened. If KakaoTalk asks something instead (while an image still uploads it asks
    /// whether to close anyway, which would drop the image), the question is left alone and the chat stays
    /// open: answering it wrongly could lose the image, and an open chat does no harm.
    /// </summary>
    static async Task CloseChatAsync(KakaoWindow kakao, IntPtr chat, Action<string> log)
    {
        // Taken once: a question that shows up late is still new on the next attempt.
        var before = KakaoWindows(kakao).ToHashSet();
        for (int attempt = 0; attempt < 3; attempt++)
        {
            if (!Native.IsWindow(chat) || !Native.IsWindowVisible(chat)) return;
            Native.PostMessage(chat, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            if (await WaitForAsync(3000, () => Native.IsWindow(chat) && Native.IsWindowVisible(chat) ? null : (bool?)true) is not null) return;
            if (KakaoWindows(kakao).FirstOrDefault(h => !before.Contains(h) && h != chat) is var question && question != IntPtr.Zero)
            {
                log($"  채팅창을 닫으려 하자 창이 뜸 0x{question:X} {Native.ClassName(question)} 제목 {Native.WindowText(question).Length}자 → 건드리지 않고 채팅창을 열어 둠");
                return;
            }
            await Task.Delay(3000, CancellationToken.None);
        }
        log("  채팅창이 닫히지 않아 열어 둠");
    }

    static async Task<T?> WaitForAsync<T>(int timeoutMs, Func<T?> probe) where T : struct
    {
        var deadline = DateTime.Now.AddMilliseconds(timeoutMs);
        while (true)
        {
            if (probe() is T value) return value;
            if (DateTime.Now >= deadline) return null;
            await Task.Delay(150, CancellationToken.None);
        }
    }

    /// <summary>
    /// The "전송" button of the image-send window, as a point in its client coordinates.
    ///
    /// KakaoTalk 26.8 on Windows ("클립보드 이미지 전송", seen 2026-11-24): a white bar along the bottom under a
    /// thin grey line, with the dark label "전송" in its middle. The line is looked for upwards from the bottom
    /// (the caption box's underline sits higher, above the preview's bottom edge), then the label's dark
    /// pixels between that line and the bottom; their middle is clicked. A label that is not roughly
    /// centred, or not the size of two characters, is not taken.
    /// A solid yellow button (other versions, like the chat's own 전송) is accepted too.
    /// </summary>
    static Point? FindSheetSendButton(IntPtr sheet)
    {
        using var img = Capture.Window(sheet);
        if (img is null) return null;
        var s = Native.GetDpiForWindow(sheet) / 96.0;
        var found = YellowButton(img, s) ?? LabelUnderLine(img, s);
        if (found is not Point at) return null;
        var rect = Native.WindowRect(sheet);
        var pt = new Native.POINT { X = rect.Left + at.X, Y = rect.Top + at.Y };
        Native.ScreenToClient(sheet, ref pt);
        return new Point(pt.X, pt.Y);
    }

    static int Luminance(Color c) => (c.R * 299 + c.G * 587 + c.B * 114) / 1000;

    /// <summary>A mostly filled KakaoTalk-yellow area in the lower part (yellow in the preview is scattered).</summary>
    static Point? YellowButton(Bitmap img, double s)
    {
        int from = Math.Max(0, img.Height - (int)(90 * s));
        int left = int.MaxValue, right = -1, top = int.MaxValue, bottom = -1, count = 0;
        for (int y = from; y < img.Height; y++)
            for (int x = 0; x < img.Width; x++)
            {
                var c = img.GetPixel(x, y);
                if (c.R < 230 || c.G < 190 || c.B > 90) continue; // KakaoTalk yellow (#FEE500)
                count++;
                left = Math.Min(left, x); right = Math.Max(right, x);
                top = Math.Min(top, y); bottom = Math.Max(bottom, y);
            }
        if (right < 0 || right - left < 30 * s || bottom - top < 15 * s) return null;
        if (count < (right - left + 1) * (bottom - top + 1) * 0.6) return null;
        return new Point((left + right) / 2, (top + bottom) / 2);
    }

    /// <summary>The dark label in the white bar under the lowest full-width grey line (see FindSheetSendButton).</summary>
    static Point? LabelUnderLine(Bitmap img, double s)
    {
        int w = img.Width, h = img.Height;
        if (w < 100 || h < 100) return null;
        int? line = null;
        for (int y = h - (int)(25 * s); y > h - (int)(120 * s) && y > 0; y--)
        {
            int grey = 0, n = 0;
            for (int x = w / 10; x < w * 9 / 10; x += 2, n++)
            {
                int lum = Luminance(img.GetPixel(x, y));
                if (lum >= 190 && lum <= 248) grey++;
            }
            if (grey >= n * 0.9) { line = y; break; }
        }
        if (line is not int lineY) return null;

        int left = int.MaxValue, right = -1, top = int.MaxValue, bottom = -1;
        for (int y = lineY + (int)(3 * s); y < h - (int)(4 * s); y++)
        {
            int dark = 0;
            for (int x = w / 4; x < w * 3 / 4; x++)
            {
                if (Luminance(img.GetPixel(x, y)) >= 140) continue;
                dark++;
                left = Math.Min(left, x); right = Math.Max(right, x);
                top = Math.Min(top, y); bottom = Math.Max(bottom, y);
            }
            if (dark > w / 4) return null; // a dark band (window edge or shadow), not a label
        }
        if (right < 0) return null;
        int labelWidth = right - left + 1, labelHeight = bottom - top + 1, middle = (left + right) / 2;
        if (labelWidth < 12 * s || labelWidth > 80 * s || labelHeight < 6 * s || labelHeight > 30 * s) return null;
        if (Math.Abs(middle - w / 2) > w / 5) return null;
        return new Point(middle, (top + bottom) / 2);
    }

    /// <summary>Visible KakaoTalk top-level windows other than the main window (chats, popups).</summary>
    static List<IntPtr> KakaoWindows(KakaoWindow kakao) =>
        Native.TopLevelWindows(kakao.ProcessId).Where(h => h != kakao.Main && Native.IsWindowVisible(h)).ToList();

    /// <summary>Whether the chat's "전송" button is lit (its input holds text); null when the chat cannot be captured.</summary>
    static bool? SendButtonLit(IntPtr chat)
    {
        using var img = Capture.Window(chat);
        if (img is null || Capture.NonBlackRatio(img) < 0.05) return null;
        return FindSendButton(chat, img) is not null; // the same capture, so the two checks cannot disagree
    }

    /// <summary>
    /// Finds the yellow "전송" button in the bottom bar of a chat window and returns a point on its label,
    /// in the chat window's client coordinates. The yellow area also holds the "▾" send-options button on
    /// its right, so the point is at a third of the yellow width, well left of it.
    /// </summary>
    static Point? FindSendButton(IntPtr chat)
    {
        using var img = Capture.Window(chat);
        return img is null ? null : FindSendButton(chat, img);
    }

    static Point? FindSendButton(IntPtr chat, Bitmap img)
    {
        var s = Native.GetDpiForWindow(chat) / 96.0;
        int bottomBar = (int)(70 * s);
        int left = int.MaxValue, right = -1, top = int.MaxValue, bottom = -1;
        for (int y = Math.Max(0, img.Height - bottomBar); y < img.Height; y++)
            for (int x = img.Width / 2; x < img.Width; x++)
            {
                var c = img.GetPixel(x, y);
                if (c.R < 230 || c.G < 190 || c.B > 90) continue; // KakaoTalk yellow (#FEE500)
                left = Math.Min(left, x); right = Math.Max(right, x);
                top = Math.Min(top, y); bottom = Math.Max(bottom, y);
            }
        if (right < 0 || right - left < 30 * s || bottom - top < 15 * s) return null;

        // Window capture coordinates → client coordinates.
        var rect = Native.WindowRect(chat);
        var pt = new Native.POINT { X = rect.Left + left + (right - left) / 3, Y = rect.Top + (top + bottom) / 2 };
        Native.ScreenToClient(chat, ref pt);
        return new Point(pt.X, pt.Y);
    }

    /// <summary>
    /// Dry-run aid: saves the chat window from the input box down (no conversation above it) to
    /// %LOCALAPPDATA%\NineTalkDaemon\chat-input.png, with the rects in the log, to check the send button.
    /// </summary>
    static void SaveInputArea(IntPtr chat, IntPtr input, Action<string> log)
    {
        var chatRect = Native.WindowRect(chat);
        var inputRect = Native.WindowRect(input);
        log($"  채팅창 {chatRect}, 입력창 {inputRect}");
        using var full = Capture.Window(chat);
        if (full is null) return;
        int top = Math.Max(0, inputRect.Top - chatRect.Top - 8);
        using var area = full.Clone(new Rectangle(0, top, full.Width, full.Height - top), full.PixelFormat);
        var path = Path.Combine(Path.GetDirectoryName(FriendSync.LogPath)!, "chat-input.png");
        area.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        log($"  입력 영역 캡처: {path} (y {top}부터)");
    }

    /// <summary>Visible KakaoTalk top-level windows other than the main window (chat rooms).</summary>
    static List<IntPtr> ChatWindows(KakaoWindow kakao) =>
        Native.TopLevelWindows(kakao.ProcessId)
            .Where(h => h != kakao.Main && Native.IsWindowVisible(h) && Native.ClassName(h).StartsWith("EVA_Window") && Native.WindowText(h).Length > 0)
            .ToList();

    static async Task<int> CountSearchRowsAsync(KakaoWindow kakao, double s, CancellationToken ct)
    {
        Bitmap? previous = null;
        try
        {
            for (int i = 0; i < 8; i++)
            {
                var current = Capture.Child(kakao.Main, kakao.FriendSearchList)
                    ?? throw new InvalidOperationException("친구 검색 결과를 캡처하지 못했습니다.");
                if (previous is not null && FriendListReader.SamePixels(previous, current))
                {
                    previous.Dispose();
                    previous = current;
                    break;
                }
                previous?.Dispose();
                previous = current;
                await Task.Delay(100, ct);
            }
            return FriendListReader.CountRows(previous!, s);
        }
        finally { previous?.Dispose(); }
    }
}
