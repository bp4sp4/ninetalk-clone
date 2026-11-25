// kakao-mac: drives KakaoTalk for Mac through the Accessibility API (no screen capture, no OCR).
// Used by ../server.mjs, which serves the same local HTTP API as the Windows daemon (DAEMON_API.md).
//
//   kakao-mac status                         → {"status": "Ready" | "NotRunning" | "LoggedOut" | "NoAccessibility"}
//   kakao-mac friends                        → {"friends": [...names], "kakao_friend_count": 428}
//   kakao-mac send <name> <text> [--image <path>]... [--file <path>]... [--image-first] [--send]
//                                            → {"result": "sent" | "dry_run_ok" | "failed", "error": "...", "detail": "..."}
//
// Without --send, `send` is a dry run: it opens the chat, puts the text in the input box and checks that the
// send button is enabled, pastes each image and file and cancels KakaoTalk's image / file sheet, then clears up
// and closes the chat. Nothing is sent. <text> may be empty when there are images or files.
// Images go first, then files; --image-first puts both before the text.
// Every command puts KakaoTalk back the way it was (tab, main window open/closed, frontmost app).

import AppKit
import ApplicationServices

let bundleID = "com.kakao.KakaoTalkMac"

// MARK: - Accessibility helpers

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}
func str(_ el: AXUIElement, _ name: String) -> String { (attr(el, name) as? String) ?? "" }
func role(_ el: AXUIElement) -> String { str(el, kAXRoleAttribute) }
func ident(_ el: AXUIElement) -> String { str(el, "AXIdentifier") }
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
@discardableResult func press(_ el: AXUIElement) -> Bool { AXUIElementPerformAction(el, kAXPressAction as CFString) == .success }
@discardableResult func set(_ el: AXUIElement, _ name: String, _ value: AnyObject) -> Bool {
    AXUIElementSetAttributeValue(el, name as CFString, value) == .success
}
/// An attribute that holds another element (focused window, close button, parent).
func element(_ el: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attr(el, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func same(_ a: AXUIElement, _ b: AXUIElement) -> Bool { CFEqual(a, b) }
/// Presses the window's close button until the window is gone (KakaoTalk can ignore it while an image uploads).
func closeWindow(_ window: AXUIElement) {
    let start = Date()
    var presses = 0
    while presses < 5 && Date().timeIntervalSince(start) < 12 {
        if isGone(window) { return }
        // An unreadable close button with the window still there means KakaoTalk is busy: wait, do not give up.
        guard let close = element(window, kAXCloseButtonAttribute) else { sleep(ms: 500); continue }
        press(close)
        presses += 1
        if waitFor(ms: 1500, { isGone(window) ? true : nil }) != nil { return }
    }
    debug("window still open after closing")
}
func descendants(_ el: AXUIElement, maxDepth: Int, where match: (AXUIElement) -> Bool) -> [AXUIElement] {
    var found = match(el) ? [el] : []
    if maxDepth > 0 { for child in children(el) { found += descendants(child, maxDepth: maxDepth - 1, where: match) } }
    return found
}
/// KakaoTalk names can arrive decomposed (jamo); compare composed forms.
func norm(_ s: String) -> String { s.precomposedStringWithCanonicalMapping }
func sleep(ms: Int) { usleep(useconds_t(ms * 1000)) }
/// Polls until `probe` returns a value or `timeout` ms of real time have passed (reading KakaoTalk's UI can
/// itself take up to the 2 s messaging timeout, so counting only the sleeps would overrun the budget).
func waitFor<T>(ms timeout: Int, step: Int = 100, _ probe: () -> T?) -> T? {
    let deadline = Date().addingTimeInterval(Double(timeout) / 1000)
    repeat {
        if let value = probe() { return value }
        if Date() >= deadline { return nil }
        sleep(ms: step)
    } while true
}

// MARK: - Output

func emit(_ object: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(0)
}
func fail(_ error: String, _ detail: String? = nil) -> Never {
    var out: [String: Any] = ["result": "failed", "error": error]
    if let detail { out["detail"] = detail }
    emit(out)
}

// MARK: - KakaoTalk

struct Kakao {
    let app: NSRunningApplication
    let root: AXUIElement

    static func running() -> Kakao? {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else { return nil }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        // A busy KakaoTalk must not stall every call for the default 6 s; the whole run has to stay well
        // under server.mjs's timeout so restore() always runs.
        AXUIElementSetMessagingTimeout(root, 2)
        return Kakao(app: app, root: root)
    }

    var windows: [AXUIElement] { (attr(root, kAXWindowsAttribute) as? [AXUIElement]) ?? [] }
    var mainWindow: AXUIElement? { windows.first { ident($0) == "Main Window" } }
    /// Chat windows (and any other non-main window) with their titles.
    var otherWindows: [AXUIElement] { windows.filter { ident($0) != "Main Window" } }

    func tabButton(_ main: AXUIElement, _ id: String) -> AXUIElement? {
        children(main).first { role($0) == "AXButton" && ident($0) == id }
    }

    /// Which tab the main window shows: the friends tab is an outline, the chats tab a table.
    func currentTab(_ main: AXUIElement) -> String {
        for child in children(main) where role(child) == "AXScrollArea" {
            for inner in children(child) {
                if role(inner) == "AXOutline" { return "friends" }
                if role(inner) == "AXTable" { return "chatrooms" }
            }
        }
        return "more"
    }

    func friendOutline(_ main: AXUIElement) -> AXUIElement? {
        for child in children(main) where role(child) == "AXScrollArea" {
            if let outline = children(child).first(where: { role($0) == "AXOutline" }) { return outline }
        }
        return nil
    }
}

/// One friend row of the "친구 N" section.
struct FriendRow {
    let row: AXUIElement
    let name: String
}

/// Reads the friends tab outline: rows under the "친구" header (my profile, updated, birthdays,
/// favourites and channels are separate sections above it and are skipped).
func friendRows(_ outline: AXUIElement) -> (rows: [FriendRow], headerCount: Int?) {
    var inFriends = false
    var headerCount: Int?
    var rows: [FriendRow] = []
    for row in (attr(outline, kAXRowsAttribute) as? [AXUIElement]) ?? [] {
        let cell = children(row).first.map(children) ?? []
        if let nameEl = cell.first(where: { ident($0) == "Display Name" }) {
            if inFriends { rows.append(FriendRow(row: row, name: str(nameEl, kAXValueAttribute))) }
            continue
        }
        // Section header row: starts with its title ("친구") and has at most a count label ("428") and a
        // fold button. Any other row without a name (a banner, the birthday carousel) is skipped and does
        // not end the section.
        guard let title = cell.first, role(title) == "AXStaticText", cell.count <= 3 else { continue }
        if norm(str(title, kAXValueAttribute)) == "친구" {
            inFriends = true
            headerCount = cell.dropFirst().compactMap { Int(str($0, kAXValueAttribute)) }.first
        } else if inFriends {
            break
        }
    }
    return (rows, headerCount)
}

// MARK: - Session: open the main window and restore everything afterwards

final class Session {
    let kakao: Kakao
    let main: AXUIElement
    private let hadMainWindow: Bool
    private let previousTab: String
    private let previousFront: NSRunningApplication?

    init?(_ kakao: Kakao) {
        self.kakao = kakao
        let front = NSWorkspace.shared.frontmostApplication
        previousFront = front
        hadMainWindow = kakao.mainWindow != nil
        if !hadMainWindow {
            // KakaoTalk closes (not hides) its main window to the menu bar; launching it again reopens it.
            let open = Process()
            open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            open.arguments = ["-b", bundleID]
            try? open.run()
            open.waitUntilExit()
        }
        guard let main = waitFor(ms: 5000, { kakao.mainWindow }) else {
            if let front, front.processIdentifier != kakao.app.processIdentifier { front.activate() }
            return nil
        }
        self.main = main
        previousTab = kakao.currentTab(main)
    }

    func activate() {
        kakao.app.activate()
        // An open chat window may be KakaoTalk's key window; bring the main window in front of it.
        AXUIElementPerformAction(main, kAXRaiseAction as CFString)
        set(main, kAXMainAttribute, kCFBooleanTrue)
        set(main, kAXFocusedAttribute, kCFBooleanTrue)
        _ = waitFor(ms: 1500) { NSWorkspace.shared.frontmostApplication?.processIdentifier == kakao.app.processIdentifier ? true : nil }
    }

    func showFriendsTab() -> AXUIElement? {
        if kakao.currentTab(main) != "friends", let button = kakao.tabButton(main, "friends") { press(button) }
        // Right after the main window opens, KakaoTalk can replace the outline and fills it gradually: a partly
        // filled (or stale) list would report a friend as "not found". Look the outline up again on every check
        // and wait until the "친구" section has as many rows as its header says ("친구 433"), or, when the header
        // has no number, until the row count stops changing.
        // Up to 15 s: with the main window just reopened, a list of 400+ friends was seen still partly filled after 6 s.
        var latest: AXUIElement?
        var lastCount = -1
        var stable = 0
        let started = Date()
        defer {
            let total = latest.map { ((attr($0, kAXRowsAttribute) as? [AXUIElement]) ?? []).count } ?? -1
            debug("friends tab: \(lastCount) rows (outline \(total)) after \(Int(Date().timeIntervalSince(started) * 1000))ms, main window was \(hadMainWindow ? "open" : "closed"), tab \(kakao.currentTab(main))")
        }
        _ = waitFor(ms: 15000, step: 200) { () -> Bool? in
            guard let outline = kakao.friendOutline(main) else { return nil }
            latest = outline
            let (rows, header) = friendRows(outline)
            if let header, header > 0 { lastCount = rows.count; return rows.count >= header ? true : nil }
            stable = rows.count > 0 && rows.count == lastCount ? stable + 1 : 0
            lastCount = rows.count
            return stable >= 3 ? true : nil
        }
        return latest
    }

    func restore() {
        if previousTab != "friends", let button = kakao.tabButton(main, previousTab) { press(button) }
        if !hadMainWindow { closeWindow(main) }
        if let front = previousFront, front.processIdentifier != kakao.app.processIdentifier {
            front.activate()
        }
    }
}

func openSession() -> Session {
    guard AXIsProcessTrusted() else { fail("kakao_not_ready", "accessibility_not_granted") }
    guard let kakao = Kakao.running() else { fail("kakao_not_ready", "not_running") }
    guard let session = Session(kakao) else { fail("kakao_not_ready", "main_window_not_found") }
    return session
}

// MARK: - Commands

func status() -> Never {
    guard let kakao = Kakao.running() else { emit(["status": "NotRunning"]) }
    guard AXIsProcessTrusted() else { emit(["status": "NoAccessibility"]) }
    if let main = kakao.mainWindow {
        emit(["status": kakao.tabButton(main, "friends") != nil ? "Ready" : "LoggedOut"])
    }
    // No main window: normally it was closed to the menu bar (chat windows may still be open).
    // A login screen is the one window with a password field.
    let login = kakao.windows.contains { window in
        !descendants(window, maxDepth: 4) { str($0, kAXSubroleAttribute) == "AXSecureTextField" }.isEmpty
    }
    emit(["status": login ? "LoggedOut" : "Ready"])
}

func friends() -> Never {
    let session = openSession()
    guard let outline = session.showFriendsTab() else { session.restore(); fail("kakao_not_ready", "friends_tab_not_found") }
    let (rows, count) = friendRows(outline)
    // No "친구" section found: KakaoTalk's layout changed. Say so instead of reporting zero friends.
    if rows.isEmpty { session.restore(); fail("kakao_not_ready", "friends_list_empty") }
    let names = rows.map { norm($0.name) }
    session.restore()
    var out: [String: Any] = ["friends": names]
    out["kakao_friend_count"] = count ?? NSNull()
    emit(out)
}

/// The chat window's message input (a text area in a scroll area that is not the message list).
func chatParts(_ chat: AXUIElement) -> (input: AXUIElement, sendButton: AXUIElement, messages: AXUIElement?)? {
    var input: AXUIElement?
    var messages: AXUIElement?
    for child in children(chat) where role(child) == "AXScrollArea" {
        for inner in children(child) {
            if role(inner) == "AXTextArea" { input = inner }
            if role(inner) == "AXTable" { messages = inner }
        }
    }
    let sendButton = children(chat).first { role($0) == "AXButton" && str($0, kAXTitleAttribute) == "전송" }
    guard let input, let sendButton else { return nil }
    return (input, sendButton, messages)
}

func setInput(_ input: AXUIElement, _ text: String) -> Bool {
    set(input, kAXFocusedAttribute, kCFBooleanTrue)
    // AXSelectedText inserts at the caret like typing/pasting, so KakaoTalk notices the change.
    if set(input, kAXSelectedTextAttribute, text as CFString), norm(str(input, kAXValueAttribute)) == norm(text) { return true }
    return set(input, kAXValueAttribute, text as CFString) && norm(str(input, kAXValueAttribute)) == norm(text)
}

func clearInput(_ input: AXUIElement) {
    set(input, kAXValueAttribute, "" as CFString)
}

/// Return goes to KakaoTalk's key window: it must be the main window with the friend list focused,
/// otherwise it could open the wrong thing or send a draft in another open chat.
/// Returns nil when ready, otherwise which check failed.
func friendListFocusProblem(_ kakao: Kakao, _ main: AXUIElement, _ outline: AXUIElement) -> String? {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == kakao.app.processIdentifier else { return "front" }
    guard let window = element(kakao.root, kAXFocusedWindowAttribute), same(window, main) else { return "window" }
    guard var focused = element(kakao.root, kAXFocusedUIElementAttribute) else { return "element" }
    for _ in 0..<6 {
        if same(focused, outline) { return nil }
        guard let parent = element(focused, kAXParentAttribute) else { break }
        focused = parent
    }
    return "element"
}

func send(name rawName: String, text rawText: String, images: [String], files: [String], imageFirst: Bool, really: Bool) -> Never {
    let name = norm(rawName)
    // A text of only spaces is no text (the dashboard checks the same with trim).
    let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : rawText
    if name.isEmpty { fail("not_found", "empty_name") }
    if text.isEmpty && images.isEmpty && files.isEmpty { fail("send_failed", "empty_text") }
    let loaded = images.map { NSImage(contentsOfFile: $0) }
    if loaded.contains(where: { $0 == nil }) { fail("send_failed", "image_unreadable") }
    if files.contains(where: { !FileManager.default.isReadableFile(atPath: $0) }) { fail("send_failed", "file_unreadable") }

    let session = openSession()
    let kakao = session.kakao
    var closeAfter: AXUIElement? // the chat window this run opened
    // Images and files go through the clipboard; whatever the user had there is put back afterwards.
    let clipboard = images.isEmpty && files.isEmpty ? nil : ClipboardBackup()
    activeClipboard = clipboard
    // From a paste until its sheet is dealt with: the image / file sheets that were already on screen, so a sheet
    // that shows up late (after we gave up waiting) is still cancelled, and the user's own sheets are left alone.
    var sheetsBeforePaste: [AXUIElement]?
    func allSheets() -> [AXUIElement] { kakao.windows.compactMap { attachSheet($0) } }
    func cancelLateSheets() {
        guard let before = sheetsBeforePaste else { return }
        sheetsBeforePaste = nil
        _ = waitFor(ms: 4000, step: 200) { () -> Bool? in
            let late = allSheets().filter { sheet in !before.contains { same($0, sheet) } }
            for sheet in late { if let cancel = sheetButton(sheet, "취소") { press(cancel) } }
            return late.isEmpty ? nil : true
        }
    }
    func finish(_ out: [String: Any]) -> Never {
        cancelLateSheets()
        if let chat = closeAfter {
            // A short pause before closing, so the last message settles in the chat (and closing does not look abrupt).
            if out["result"] as? String == "sent" { sleep(ms: 1500) }
            closeChat(kakao, chat)
        }
        clipboard?.restore()
        session.restore()
        emit(out)
    }
    func failed(_ error: String, _ detail: String? = nil) -> Never {
        var out: [String: Any] = ["result": "failed", "error": error]
        if let detail { out["detail"] = detail }
        finish(out)
    }

    guard let outline = session.showFriendsTab() else { failed("kakao_not_ready", "friends_tab_not_found") }
    let allRows = friendRows(outline).rows
    // No "친구" section found: KakaoTalk's layout changed, so every name would be "not found". Stop the job instead.
    if allRows.isEmpty { failed("kakao_not_ready", "friends_list_empty") }
    let matches = allRows.filter { norm($0.name) == name }
    if matches.isEmpty {
        if debugEnabled {
            let names = allRows.map { norm($0.name) }
            debug("not found among \(names.count) rows: \(names.filter(\.isEmpty).count) empty, \(Set(names).count) distinct")
            sleep(ms: 2000)
            let again = friendRows(session.kakao.friendOutline(session.main) ?? outline).rows.map { norm($0.name) }
            debug("2s later: \(again.count) rows, \(again.filter(\.isEmpty).count) empty, \(Set(again).count) distinct, match \(again.filter { $0 == name }.count)")
        }
        failed("not_found")
    }
    if matches.count > 1 { failed("duplicate_name", "\(matches.count)") }
    let row = matches[0].row

    // The chat is always opened from the friend row, never picked by window title alone
    // (a group chat or open chat can have the same name).
    let before = kakao.otherWindows
    let isNew = { (window: AXUIElement) in !before.contains { same($0, window) } }
    session.activate()
    guard set(outline, kAXSelectedRowsAttribute, [row] as CFArray),
          ((attr(outline, kAXSelectedRowsAttribute) as? [AXUIElement]) ?? []).contains(where: { same($0, row) }) else {
        failed("send_failed", "select_failed")
    }
    set(outline, kAXFocusedAttribute, kCFBooleanTrue)
    var focusProblem: String? = "front"
    _ = waitFor(ms: 1500) { () -> Bool? in
        focusProblem = friendListFocusProblem(kakao, session.main, outline)
        return focusProblem == nil ? true : nil
    }
    if let focusProblem { failed("send_failed", "focus_failed:\(focusProblem)") }
    let source = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: 36 /* Return */, keyDown: down) else { continue }
        event.flags = [] // a modifier the user happens to hold must not turn this into Cmd+Return etc.
        event.postToPid(kakao.app.processIdentifier)
    }

    // A new window titled with the name, or, when that chat was already open, the window KakaoTalk brought to the front.
    let chat: AXUIElement? = waitFor(ms: 4000) {
        if let fresh = kakao.otherWindows.first(where: { isNew($0) && norm(str($0, kAXTitleAttribute)) == name }) { return fresh }
        if let focused = element(kakao.root, kAXFocusedWindowAttribute), !same(focused, session.main), !isNew(focused),
           norm(str(focused, kAXTitleAttribute)) == name {
            return focused
        }
        return nil
    }
    guard let chat else {
        let fresh = kakao.otherWindows.filter(isNew)
        // Something else opened (a profile, another room): close it only when it is clearly the one that appeared.
        if fresh.count == 1 { closeWindow(fresh[0]) }
        if fresh.isEmpty { failed("send_failed", "chat_not_opened") }
        failed("room_mismatch")
    }
    if isNew(chat) { closeAfter = chat }

    guard let firstParts = waitFor(ms: 2000, { chatParts(chat) }) else { failed("send_failed", "input_not_found") }
    var parts = firstParts
    // KakaoTalk can replace the chat's elements after a send (seen on 26.8 after a file: the old message table
    // answered with no rows), so every step looks them up again before it starts.
    func refreshParts() { if let fresh = chatParts(chat) { parts = fresh } }

    // Someone's unsent draft: never overwrite it or send it along.
    if !str(parts.input, kAXValueAttribute).isEmpty { failed("send_failed", "input_not_empty") }

    // Text and images go out in order; once one step has gone out, a later failure is "partial_sent" so the
    // dashboard does not offer to send the whole thing again.
    var sentSteps = 0
    var allConfirmed = true
    func stepFailed(_ detail: String) -> Never {
        failed(sentSteps > 0 ? "partial_sent" : "send_failed", detail)
    }

    func sendText() {
        refreshParts()
        // From here until the send, a termination takes our text back out of the input box.
        activeInput = (parts.input, norm(text))
        defer { activeInput = nil }
        guard setInput(parts.input, text) else {
            clearInput(parts.input)
            stepFailed("input_rejected")
        }
        let enabled = waitFor(ms: 1500) { (attr(parts.sendButton, kAXEnabledAttribute) as? Bool) == true ? true : nil } ?? false
        if !really {
            clearInput(parts.input)
            if !enabled { stepFailed("send_button_disabled") }
            if !str(parts.input, kAXValueAttribute).isEmpty { stepFailed("input_not_cleared") }
            return
        }
        guard enabled else {
            clearInput(parts.input)
            stepFailed("send_button_disabled")
        }
        let wanted = norm(text)
        // KakaoTalk is in front while this runs, so keys typed meanwhile could land in the box: send only our exact text.
        guard norm(str(parts.input, kAXValueAttribute)) == wanted else {
            clearInput(parts.input)
            stepFailed("input_changed")
        }
        // The press can report an error (KakaoTalk busy past the messaging timeout) although the message went
        // out, so judge by what happened, never by the return code: reporting a sent message as failed would get
        // it sent again later.
        let rowsBefore = rowCount(parts.messages)
        let countBefore = recentTexts(parts.messages).filter { $0 == wanted }.count
        if debugEnabled { debug("before text: " + lastRowsShape(parts.messages, 3)) }
        let pressed = press(parts.sendButton)
        // Sent = the input box emptied. Confirmed = a row that was not there before shows the text (an earlier
        // message with the same text must not count).
        let emptied = waitFor(ms: 5000) { str(parts.input, kAXValueAttribute).isEmpty ? true : nil } ?? false
        let confirmed = waitFor(ms: emptied ? 3000 : 1000) {
            recentTexts(parts.messages, addedSince: rowsBefore).filter { $0 == wanted }.count > countBefore ? true : nil
        } ?? false
        if !emptied && !confirmed {
            clearInput(parts.input)
            stepFailed(pressed ? "input_not_cleared" : "press_failed")
        }
        if !emptied { clearInput(parts.input) }
        sentSteps += 1
        allConfirmed = allConfirmed && confirmed
    }

    func sendImage(_ image: NSImage) {
        refreshParts()
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        guard pasteboard.writeObjects([image]) else { stepFailed("clipboard_failed") }
        clipboard?.ourChangeCount = pasteboard.changeCount
        // Cmd+V goes to KakaoTalk's key window: it must be this chat with its input box focused.
        set(parts.input, kAXFocusedAttribute, kCFBooleanTrue)
        let focused = waitFor(ms: 1500) { () -> Bool? in
            guard let window = element(kakao.root, kAXFocusedWindowAttribute), same(window, chat),
                  let field = element(kakao.root, kAXFocusedUIElementAttribute), same(field, parts.input) else { return nil }
            return true
        }
        guard focused != nil else { stepFailed("focus_failed:image") }
        let rowsBefore = rowCount(parts.messages)
        let imagesBefore = imageOnlyRows(parts.messages).count
        if debugEnabled { debug("before image: " + lastRowsShape(parts.messages, 3)) }
        // From the paste on, a termination cancels this chat's image sheet even before we have found it.
        activeChat = chat
        defer { activeChat = nil; activeSheet = nil }
        sheetsBeforePaste = allSheets()
        postKey(kakao.app.processIdentifier, 9 /* V */, .maskCommand)
        // KakaoTalk shows an image sheet: preview, caption box, 취소 / 전송.
        guard let sheet = waitFor(ms: 4000, { imageSheet(chat) }) else {
            if !str(parts.input, kAXValueAttribute).isEmpty { clearInput(parts.input) }
            // A sheet that shows up late, or in another chat (focus moved at the last moment), must not stay there
            // for someone to send by pressing Return: finish() cancels any new one.
            stepFailed("image_sheet_not_shown")
        }
        sheetsBeforePaste = nil
        activeSheet = sheet
        guard let button = sheetButton(sheet, really ? "전송" : "취소") else {
            if let cancel = sheetButton(sheet, "취소") { press(cancel) }
            stepFailed("image_button_not_found")
        }
        // As with the text, the press may report an error although it worked: the sheet closing is what counts.
        press(button)
        guard waitFor(ms: 8000, { imageSheet(chat) == nil ? true : nil }) != nil else {
            // Still open: nothing was sent from it. Cancel so the image does not stay queued in the chat.
            if let cancel = sheetButton(sheet, "취소") { press(cancel) }
            stepFailed("image_sheet_stuck")
        }
        // Closed: from here a termination must not press anything in this chat (the image is on its way).
        activeSheet = nil
        activeChat = nil
        if !really { return }
        sentSteps += 1
        // The image row appears at once, but the upload is only done when it gets its time label and a 공유
        // button, like a sent text. Moving on (or closing the chat) earlier makes KakaoTalk ask "닫으시면 ...
        // 보내지지 않습니다" and can drop the image.
        // Counted, not compared by element identity: KakaoTalk may rebuild or reuse row elements.
        let appeared = waitFor(ms: 8000, step: 200) {
            imageOnlyRows(parts.messages, addedSince: rowsBefore).count > imagesBefore ? true : nil
        } ?? false
        let uploadStart = Date()
        let uploaded = appeared && (waitFor(ms: 45000, step: 300) {
            imageOnlyRows(parts.messages).last.map(imageRowUploaded) == true ? true : nil
        } ?? false)
        if debugEnabled { debug("after image: " + lastRowsShape(parts.messages, 3)) }
        debug("image appeared=\(appeared) uploaded=\(uploaded) after \(Int(Date().timeIntervalSince(uploadStart) * 1000))ms")
        allConfirmed = allConfirmed && uploaded
    }

    /// One file: its URL goes on the clipboard, Cmd+V in the input box, and KakaoTalk shows a "파일 전송" sheet
    /// whose button reads "1개 전송" (one file each time, so the button names exactly what we pasted).
    func sendFile(_ path: String) {
        refreshParts()
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        guard pasteboard.writeObjects([URL(fileURLWithPath: path) as NSURL]) else { stepFailed("clipboard_failed") }
        clipboard?.ourChangeCount = pasteboard.changeCount
        set(parts.input, kAXFocusedAttribute, kCFBooleanTrue)
        let focused = waitFor(ms: 1500) { () -> Bool? in
            guard let window = element(kakao.root, kAXFocusedWindowAttribute), same(window, chat),
                  let field = element(kakao.root, kAXFocusedUIElementAttribute), same(field, parts.input) else { return nil }
            return true
        }
        guard focused != nil else { stepFailed("focus_failed:file") }
        let rowsBefore = rowCount(parts.messages)
        let filesBefore = sentFileRows(parts.messages).count
        if debugEnabled {
            let timed = sentFileRows(parts.messages).filter(rowHasTime).count
            debug("before file (\(filesBefore) sent files in view, \(timed) with a time): " + lastRowsShape(parts.messages, 3))
        }
        // From the paste on, a termination cancels this chat's file sheet even before we have found it.
        activeChat = chat
        defer { activeChat = nil; activeSheet = nil }
        sheetsBeforePaste = allSheets()
        postKey(kakao.app.processIdentifier, 9 /* V */, .maskCommand)
        // Any sheet with 취소: the file sheet, or something else KakaoTalk shows instead (a size limit, an image
        // sheet for a picture file). Only the file sheet with its "1개 전송" button is ever pressed.
        guard let sheet = waitFor(ms: 4000, { attachSheet(chat) }) else {
            // The paste may have put the path in as text instead: take it back out (the box was empty before).
            if !str(parts.input, kAXValueAttribute).isEmpty { clearInput(parts.input) }
            // A late sheet, or one in another chat (focus moved at the last moment): finish() cancels any new one.
            stepFailed("file_sheet_not_shown")
        }
        sheetsBeforePaste = nil
        activeSheet = sheet
        // Buttons only: the sheet's text holds the file name, which stays out of every log.
        if debugEnabled { debug("file sheet buttons: " + descendants(sheet, maxDepth: 3) { role($0) == "AXButton" }.map { str($0, kAXTitleAttribute) }.joined(separator: ",")) }
        guard fileSheet(chat) != nil, let button = sheetButton(sheet, really ? "1개 전송" : "취소") else {
            if let cancel = sheetButton(sheet, "취소") { press(cancel) } else { postKey(kakao.app.processIdentifier, 53 /* Escape */, []) }
            stepFailed("file_sheet_unexpected")
        }
        press(button)
        guard waitFor(ms: 8000, { attachSheet(chat) == nil ? true : nil }) != nil else {
            // Still a sheet on the chat. Cancel whichever is there now, so nothing stays queued for a stray Return.
            let current = attachSheet(chat)
            if let current, let cancel = sheetButton(current, "취소") { press(cancel) }
            // The same file sheet: nothing went out from it. A different one (KakaoTalk answered the press with a
            // question of its own): the file may have gone out, so never report it as a plain failure.
            if !really || current.map({ same($0, sheet) }) ?? true { stepFailed("file_sheet_stuck") }
            failed("unknown_result", "file_sheet_changed")
        }
        activeSheet = nil
        activeChat = nil
        if !really { return }
        sentSteps += 1
        // As with images: the file row appears at once, the upload is done when it gets its time label or a 공유
        // button. Closing the chat earlier makes KakaoTalk ask "닫으시면 ... 보내지지 않습니다".
        // The message table is looked up again on every check: after a file is sent KakaoTalk replaced it, and the
        // old element answered with no rows (seen on 26.8: the file arrived, the old table stayed empty).
        let messages = { chatParts(chat)?.messages ?? parts.messages }
        let appeared = waitFor(ms: 8000, step: 200) { rowCount(messages()) > rowsBefore ? true : nil } ?? false
        let uploadStart = Date()
        // Counted like images: one more finished file row among the newest rows than before.
        let uploaded = appeared && (waitFor(ms: 90000, step: 300) {
            sentFileRows(messages(), addedSince: rowsBefore).count > filesBefore ? true : nil
        } ?? false)
        if debugEnabled { debug("after file: " + lastRowsShape(messages(), 3)) }
        debug("file appeared=\(appeared) uploaded=\(uploaded) after \(Int(Date().timeIntervalSince(uploadStart) * 1000))ms")
        allConfirmed = allConfirmed && uploaded
    }

    let imageSteps = loaded.compactMap { $0 }
    func sendAttachments() {
        imageSteps.forEach(sendImage)
        files.forEach(sendFile)
    }
    if imageFirst {
        sendAttachments()
        if !text.isEmpty { sendText() }
    } else {
        if !text.isEmpty { sendText() }
        sendAttachments()
    }
    if !really { finish(["result": "dry_run_ok", "images": imageSteps.count, "files": files.count]) }
    finish(["result": "sent", "confirmed": allConfirmed, "images": imageSteps.count, "files": files.count])
}

// MARK: - Images

/// Snapshot of the general pasteboard, put back after images were pasted through it.
final class ClipboardBackup {
    private let items: [[NSPasteboard.PasteboardType: Data]]
    /// The pasteboard's change count right after we last wrote an image; if it moved on, the user copied
    /// something meanwhile and that must not be overwritten.
    var ourChangeCount: Int?
    private var restored = false
    init() {
        items = (NSPasteboard.general.pasteboardItems ?? []).map { item in
            var data: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types { if let value = item.data(forType: type) { data[type] = value } }
            return data
        }
    }
    func restore() {
        if restored { return }
        restored = true
        let pasteboard = NSPasteboard.general
        guard let ours = ourChangeCount, pasteboard.changeCount == ours else { return }
        pasteboard.clearContents()
        let restored = items.map { data -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, value) in data { item.setData(value, forType: type) }
            return item
        }
        if !restored.isEmpty { pasteboard.writeObjects(restored) }
    }
}

/// Set while images and files go through the clipboard, so a termination (server.mjs timeout) still puts it back.
var activeClipboard: ClipboardBackup?
/// The image or file sheet on screen, cancelled if we are terminated while it is open.
var activeSheet: AXUIElement?
/// The chat an image was just pasted into, until its sheet closes: a termination before the sheet was found
/// still looks for it there.
var activeChat: AXUIElement?
/// The input box holding our text before it is sent, so a termination does not leave it there for a stray
/// Return to send (only cleared while it still holds exactly our text).
var activeInput: (input: AXUIElement, text: String)?
let terminationSource: DispatchSourceSignal = {
    signal(SIGTERM, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    source.setEventHandler {
        // Cut off (server.mjs timeout): never leave an image or file sheet behind for a stray Return to send.
        if let sheet = activeSheet ?? activeChat.flatMap({ attachSheet($0) }), let cancel = sheetButton(sheet, "취소") { press(cancel) }
        if let (input, text) = activeInput, norm(str(input, kAXValueAttribute)) == text { clearInput(input) }
        activeClipboard?.restore()
        exit(143)
    }
    source.resume()
    return source
}()

func postKey(_ pid: pid_t, _ code: CGKeyCode, _ flags: CGEventFlags) {
    let source = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
        event.flags = flags
        event.postToPid(pid)
    }
}

/// KakaoTalk's "send image" sheet on a chat window (it has both 취소 and 전송 buttons).
func imageSheet(_ chat: AXUIElement) -> AXUIElement? {
    children(chat).first { role($0) == "AXSheet" && sheetButton($0, "전송") != nil && sheetButton($0, "취소") != nil }
}

/// KakaoTalk's "파일 전송" sheet for one pasted file: a 취소 and a "1개 전송" button.
func fileSheet(_ chat: AXUIElement) -> AXUIElement? {
    children(chat).first { sheet in
        role(sheet) == "AXSheet" && sheetButton(sheet, "1개 전송") != nil && sheetButton(sheet, "취소") != nil
            && !descendants(sheet, maxDepth: 3, where: { role($0) == "AXStaticText" && str($0, kAXValueAttribute) == "파일 전송" }).isEmpty
    }
}

/// Any sheet on the chat that can be cancelled (image, file, or a sheet KakaoTalk shows instead).
func attachSheet(_ chat: AXUIElement) -> AXUIElement? {
    children(chat).first { role($0) == "AXSheet" && sheetButton($0, "취소") != nil }
}

func sheetButton(_ sheet: AXUIElement, _ title: String) -> AXUIElement? {
    descendants(sheet, maxDepth: 3) { role($0) == "AXButton" && str($0, kAXTitleAttribute) == title }.first
}

/**
 * Closes a chat window this run opened. While an image is still uploading KakaoTalk refuses with a
 * "닫으시면 ... 보내지지 않습니다" confirmation: answer it with the button that keeps the chat open (취소, else
 * Escape), give the upload time and try again, for up to 30 seconds. Never confirms closing.
 */
func closeChat(_ kakao: Kakao, _ chat: AXUIElement) {
    let start = Date()
    while Date().timeIntervalSince(start) < 30 {
        if isGone(chat) { return }
        guard let close = element(chat, kAXCloseButtonAttribute) else { sleep(ms: 500); continue } // busy, not gone
        let windowsBefore = kakao.windows
        press(close)
        if waitFor(ms: 1500, { isGone(chat) ? true : nil }) != nil { return }
        if let dialog = closeConfirmation(kakao, chat, windowsBefore) {
            debug("close confirmation: " + dialogShape(dialog))
            if let keep = descendants(dialog, maxDepth: 4, where: { role($0) == "AXButton" && str($0, kAXTitleAttribute) == "취소" }).first {
                press(keep)
            } else {
                postKey(kakao.app.processIdentifier, 53 /* Escape */, [])
            }
            _ = waitFor(ms: 2000) { closeConfirmation(kakao, chat, windowsBefore) == nil ? true : nil }
        }
        sleep(ms: 2000) // let the upload go on
    }
    debug("chat still open after 30s")
}

/// The element no longer exists (closed), as opposed to KakaoTalk being too busy to answer in time.
func isGone(_ element: AXUIElement) -> Bool {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value) == .invalidUIElement
}

/// A sheet on the chat, or a new window without a message input, that appeared after pressing close.
func closeConfirmation(_ kakao: Kakao, _ chat: AXUIElement, _ windowsBefore: [AXUIElement]) -> AXUIElement? {
    if let sheet = children(chat).first(where: { role($0) == "AXSheet" }) { return sheet }
    return kakao.windows.first { window in
        !windowsBefore.contains { same($0, window) } && !same(window, chat) && ident(window) != "Main Window"
    }
}

// MARK: - Debug (KAKAO_MAC_DEBUG=1, stderr; UI labels and roles only, never message text or names)

let debugEnabled = ProcessInfo.processInfo.environment["KAKAO_MAC_DEBUG"] == "1"
func debug(_ line: String) {
    guard debugEnabled else { return }
    FileHandle.standardError.write("[debug] \(line)\n".data(using: .utf8)!)
}
func dialogShape(_ element: AXUIElement) -> String {
    descendants(element, maxDepth: 4) { ["AXButton", "AXStaticText"].contains(role($0)) }.map { e in
        let label = [str(e, kAXTitleAttribute), str(e, kAXValueAttribute), str(e, kAXDescriptionAttribute)].first { !$0.isEmpty } ?? ""
        return "\(role(e))(\(label.prefix(60)))"
    }.joined(separator: " ")
}
func lastRowsShape(_ table: AXUIElement?, _ count: Int) -> String {
    guard let table else { return "-" }
    let rows = ((attr(table, kAXRowsAttribute) as? [AXUIElement]) ?? []).suffix(count)
    return rows.map { row in
        descendants(row, maxDepth: 4) { _ in true }.map { e -> String in
            let r = role(e)
            let label = r == "AXButton" ? (str(e, kAXTitleAttribute) + str(e, kAXDescriptionAttribute) + str(e, kAXHelpAttribute)).prefix(20) : ""
            return label.isEmpty ? r : "\(r)[\(label)]"
        }.joined(separator: ",")
    }.joined(separator: " | ")
}

// The newest message rows, read by content. Checks compare counts of matching rows before and after a send,
// which holds whether KakaoTalk rebuilds row elements or reuses them for new messages.
// Before: the last 8 rows. After: the last 8 plus however many rows were added, so the same 8 old rows are
// still in view and a chat whose last 8 rows already match (the same image sent again) is not miscounted.
// If KakaoTalk keeps the row count fixed and drops old rows instead, nothing is added and the window stays 8:
// at worst a message goes unconfirmed, never confirmed wrongly.
func rowCount(_ table: AXUIElement?) -> Int {
    guard let table else { return 0 }
    return ((attr(table, kAXRowsAttribute) as? [AXUIElement]) ?? []).count
}
func recentRows(_ table: AXUIElement?, addedSince before: Int? = nil) -> [AXUIElement] {
    guard let table else { return [] }
    let rows = (attr(table, kAXRowsAttribute) as? [AXUIElement]) ?? []
    let added = before.map { max(0, rows.count - $0) } ?? 0
    return Array(rows.suffix(8 + added))
}
func rowTexts(_ row: AXUIElement) -> [String] {
    descendants(row, maxDepth: 3) { role($0) == "AXTextArea" }.map { norm(str($0, kAXValueAttribute)) }
}
func recentTexts(_ table: AXUIElement?, addedSince before: Int? = nil) -> [String] {
    recentRows(table, addedSince: before).flatMap(rowTexts)
}
/// Image messages among the newest rows: a row with an image and no message text.
func imageOnlyRows(_ table: AXUIElement?, addedSince before: Int? = nil) -> [AXUIElement] {
    recentRows(table, addedSince: before).filter { row in
        !descendants(row, maxDepth: 4) { role($0) == "AXImage" }.isEmpty && rowTexts(row).allSatisfy { $0.isEmpty }
    }
}
/// A file message whose upload is done: its row has 공유 and 열기 / "Finder에서 보기" buttons (26.8).
/// (Checked on a sent file only; how the row looks during an upload has not been seen.)
func sentFileRows(_ table: AXUIElement?, addedSince before: Int? = nil) -> [AXUIElement] {
    recentRows(table, addedSince: before).filter { row in
        let labels = descendants(row, maxDepth: 4) { role($0) == "AXButton" }.map { str($0, kAXTitleAttribute) + str($0, kAXDescriptionAttribute) }
        return labels.contains { $0.contains("공유") } && labels.contains { $0.contains("Finder에서 보기") || $0.contains("열기") }
    }
}
/// Upload finished: the image row shows a 공유 (share) button or its sent time ("오후 3:12").
func imageRowUploaded(_ row: AXUIElement) -> Bool {
    let parts = descendants(row, maxDepth: 4) { _ in true }
    let hasShare = parts.contains { role($0) == "AXButton" && (str($0, kAXTitleAttribute) + str($0, kAXDescriptionAttribute)).contains("공유") }
    return hasShare || rowHasTime(row)
}
/// The row shows a sent time ("오후 3:12").
func rowHasTime(_ row: AXUIElement) -> Bool {
    descendants(row, maxDepth: 4) { role($0) == "AXStaticText" && str($0, kAXValueAttribute).range(of: #"^(오전|오후)\s?\d{1,2}:\d{2}$"#, options: .regularExpression) != nil }.count > 0
}


// MARK: - Main

_ = terminationSource // install the SIGTERM handler before any work
let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "status": status()
case "friends": friends()
case "send" where args.count >= 3:
    var images: [String] = []
    var files: [String] = []
    var imageFirst = false
    var really = false
    var rest = Array(args.dropFirst(3))
    while !rest.isEmpty {
        let flag = rest.removeFirst()
        switch flag {
        case "--send": really = true
        case "--image-first": imageFirst = true
        case "--image" where !rest.isEmpty: images.append(rest.removeFirst())
        case "--file" where !rest.isEmpty: files.append(rest.removeFirst())
        default:
            FileHandle.standardError.write("unknown option \(flag)\n".data(using: .utf8)!)
            exit(2)
        }
    }
    send(name: args[1], text: args[2], images: images, files: files, imageFirst: imageFirst, really: really)
default:
    FileHandle.standardError.write("usage: kakao-mac status | friends | send <name> <text> [--image <path>]... [--file <path>]... [--image-first] [--send]\n".data(using: .utf8)!)
    exit(2)
}
