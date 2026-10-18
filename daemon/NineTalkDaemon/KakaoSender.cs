namespace NineTalkDaemon;

/// <summary>
/// Sends one text message to one friend through the PC KakaoTalk window.
///
/// Steps (all Win32 messages, no global keyboard/mouse input):
/// 1. Put the name into the friend tab's search box (WM_SETTEXT) and count the result rows on a capture.
///    0 rows → not_found, 2+ rows → duplicate_name; nothing is opened.
/// 2. Enter in the search box opens the chat with the (single) result.
/// 3. The new chat window's title (GetWindowText) must equal the name exactly, else room_mismatch.
/// 4. The text goes into the chat's RichEdit with EM_REPLACESEL. In dry-run the daemon stops here, clears
///    the input and closes the chat. Otherwise the yellow "전송" button is clicked, and an empty input
///    afterwards confirms the send.
/// 5. The chat window is closed (WM_CLOSE) unless it was already open before.
///
/// Verified on KakaoTalk 26.8: a real message went out through the "전송" button click. Posted Enter keys
/// do not send, and text set with WM_SETTEXT leaves the button disabled (README, "발송").
/// </summary>
static class KakaoSender
{
    const int SearchCloseX = 295, SearchCloseY = 73; // "X" beside the friend search box, ContactListView coords

    public static async Task<string?> SendOneAsync(KakaoWindow kakao, string name, string text, bool dryRun, Action<string> log, CancellationToken ct)
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
            log($"  '{name}' 검색 결과 {rows}명");
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
                log($"  채팅창 0x{chat:X} {Native.ClassName(chat)} '{title}' (새로 열림: {openedByUs}), 자식: "
                    + string.Join(", ", Native.ChildWindows(chat).Select(h => Native.ClassName(h)).Distinct()));
                if (title != name)
                {
                    log($"  채팅방 제목 '{title}' ≠ '{name}'");
                    return "room_mismatch";
                }

                // 4. Text into the input, then Enter.
                var input = Native.ChildWindows(chat).FirstOrDefault(h => Native.ClassName(h).StartsWith("RICHEDIT", StringComparison.OrdinalIgnoreCase));
                if (input == IntPtr.Zero) { log("  입력창을 찾지 못함"); return "send_failed"; }
                Native.ReplaceText(input, text);
                await Task.Delay(300, ct);
                if (Native.TextLength(input) == 0) { log("  입력창에 문구가 들어가지 않음"); return "send_failed"; }

                // Send with the yellow "전송" button. It turns yellow only once KakaoTalk has registered
                // the text, which doubles as a check that the text really went in.
                Point? button = null;
                for (int i = 0; i < 10 && button is null; i++)
                {
                    button = FindSendButton(chat);
                    if (button is null) await Task.Delay(150, ct);
                }
                log(button is Point p ? $"  전송 버튼 {p.X},{p.Y} (채팅창 기준)" : "  전송 버튼을 찾지 못함");

                if (dryRun)
                {
                    log("  [dry-run] 입력창에 넣기까지만 하고 보내지 않음");
                    SaveInputArea(chat, input, log);
                    await Task.Delay(1500, ct); // time to look at it
                    Native.SetText(input, "");
                    return button is null ? "send_failed" : null;
                }
                if (button is not Point click) { Native.SetText(input, ""); return "send_failed"; }

                FriendListReader.Click(chat, click.X, click.Y);
                // Sent = the button went back to grey (KakaoTalk emptied its input). WM_GETTEXTLENGTH is not
                // used: on a real send it still reported the old text, which once turned a sent message
                // into send_failed.
                for (int i = 0; i < 25; i++)
                {
                    await Task.Delay(200, CancellationToken.None); // never abandon a send half-way
                    if (FindSendButton(chat) is null) return null;
                }
                log("  전송 버튼을 누른 뒤에도 버튼이 활성 상태로 남음");
                Native.SetText(input, "");
                return "send_failed";
            }
            finally
            {
                // 5. Close what we opened.
                if (openedByUs && Native.IsWindow(chat)) Native.PostMessage(chat, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                await Task.Delay(300, CancellationToken.None);
            }
        }
        finally
        {
            Native.SetText(kakao.FriendSearchEdit, "");
            FriendListReader.Click(kakao.ContactView, S(SearchCloseX), S(SearchCloseY));
        }
    }

    /// <summary>
    /// Finds the yellow "전송" button in the bottom bar of a chat window and returns a point on its label,
    /// in the chat window's client coordinates. The yellow area also holds the "▾" send-options button on
    /// its right, so the point is at a third of the yellow width, well left of it.
    /// </summary>
    static Point? FindSendButton(IntPtr chat)
    {
        using var img = Capture.Window(chat);
        if (img is null) return null;
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
