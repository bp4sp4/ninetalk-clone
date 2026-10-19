// kakao-mac: drives KakaoTalk for Mac through the Accessibility API (no screen capture, no OCR).
// Used by ../server.mjs, which serves the same local HTTP API as the Windows daemon (DAEMON_API.md).
//
//   kakao-mac status                         → {"status": "Ready" | "NotRunning" | "LoggedOut" | "NoAccessibility"}
//   kakao-mac friends                        → {"friends": [...names], "kakao_friend_count": 428}
//   kakao-mac send <name> <text> [--send]    → {"result": "sent" | "dry_run_ok" | "failed", "error": "...", "detail": "..."}
//
// Without --send, `send` is a dry run: it opens the chat, puts the text in the input box, checks that the
// send button is enabled, clears the box and closes the chat. Nothing is sent.
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
func closeWindow(_ window: AXUIElement) {
    if let close = element(window, kAXCloseButtonAttribute) { press(close) }
}
func descendants(_ el: AXUIElement, maxDepth: Int, where match: (AXUIElement) -> Bool) -> [AXUIElement] {
    var found = match(el) ? [el] : []
    if maxDepth > 0 { for child in children(el) { found += descendants(child, maxDepth: maxDepth - 1, where: match) } }
    return found
}
/// KakaoTalk names can arrive decomposed (jamo); compare composed forms.
func norm(_ s: String) -> String { s.precomposedStringWithCanonicalMapping }
func sleep(ms: Int) { usleep(useconds_t(ms * 1000)) }
func waitFor<T>(ms timeout: Int, step: Int = 100, _ probe: () -> T?) -> T? {
    var waited = 0
    while waited <= timeout {
        if let value = probe() { return value }
        sleep(ms: step)
        waited += step
    }
    return nil
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
        return waitFor(ms: 2000) { kakao.friendOutline(main) }
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

/// Texts of the last few messages in the chat (newest last).
func lastMessages(_ table: AXUIElement?, count: Int) -> [String] {
    guard let table else { return [] }
    let rows = (attr(table, kAXRowsAttribute) as? [AXUIElement]) ?? []
    return rows.suffix(count).flatMap { row in
        descendants(row, maxDepth: 3) { role($0) == "AXTextArea" }.map { norm(str($0, kAXValueAttribute)) }
    }
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

func send(name rawName: String, text: String, really: Bool) -> Never {
    let name = norm(rawName)
    if name.isEmpty { fail("not_found", "empty_name") }
    if text.isEmpty { fail("send_failed", "empty_text") }

    let session = openSession()
    let kakao = session.kakao
    var closeAfter: AXUIElement? // the chat window this run opened
    func finish(_ out: [String: Any]) -> Never {
        if let chat = closeAfter { closeWindow(chat) }
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
    if matches.isEmpty { failed("not_found") }
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

    guard let parts = waitFor(ms: 2000, { chatParts(chat) }) else { failed("send_failed", "input_not_found") }

    // Someone's unsent draft: never overwrite it or send it along.
    if !str(parts.input, kAXValueAttribute).isEmpty { failed("send_failed", "input_not_empty") }

    guard setInput(parts.input, text) else {
        clearInput(parts.input)
        failed("send_failed", "input_rejected")
    }
    let enabled = waitFor(ms: 1500) { (attr(parts.sendButton, kAXEnabledAttribute) as? Bool) == true ? true : nil } ?? false

    if !really {
        clearInput(parts.input)
        let cleared = str(parts.input, kAXValueAttribute).isEmpty
        finish(["result": "dry_run_ok", "send_button_enabled": enabled, "cleared": cleared])
    }
    guard enabled else {
        clearInput(parts.input)
        failed("send_failed", "send_button_disabled")
    }

    let wanted = norm(text)
    // KakaoTalk is in front while this runs, so keys typed meanwhile could land in the box: send only our exact text.
    guard norm(str(parts.input, kAXValueAttribute)) == wanted else {
        clearInput(parts.input)
        failed("send_failed", "input_changed")
    }
    guard press(parts.sendButton) else {
        clearInput(parts.input)
        failed("send_failed", "press_failed")
    }
    // Sent = the input box emptied. Confirmed = the newest messages include the text.
    let emptied = waitFor(ms: 5000) { str(parts.input, kAXValueAttribute).isEmpty ? true : nil } ?? false
    let confirmed = waitFor(ms: emptied ? 3000 : 1000) { lastMessages(parts.messages, count: 3).contains(wanted) ? true : nil } ?? false
    if !emptied {
        clearInput(parts.input)
        // The button was pressed: when the message shows in the chat it went out, and reporting a failure would
        // make it be sent again later.
        if confirmed { finish(["result": "sent", "confirmed": true, "detail": "input_not_cleared"]) }
        failed("send_failed", "input_not_cleared")
    }
    finish(["result": "sent", "confirmed": confirmed])
}

// MARK: - Main

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "status": status()
case "friends": friends()
case "send" where args.count >= 3: send(name: args[1], text: args[2], really: args.dropFirst(3).contains("--send"))
default:
    FileHandle.standardError.write("usage: kakao-mac status | friends | send <name> <text> [--send]\n".data(using: .utf8)!)
    exit(2)
}
