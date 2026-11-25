// 오피스 사용 허가 토큰 (../../docs/office-license-spec.md). The office says whether this PC may use the app:
// once when the app starts and then every few minutes while it runs. The office endpoint sends no CORS headers,
// so it is called here in the main process, never from a window.
//
// Rules (set by the user):
// - One employee, one PC: the office ties a token to the first deviceId it sees.
// - 200 = may use. 403 = lock now. Anything else (other status, no connection, timeout) = "cannot reach the
//   office": keep working until offlineGraceSec (24 h) after the last success, then lock.
// - A PC clock set back before the last success gets no offline grace.
// - A 403 never deletes the saved token (device_mismatch can be fixed on the office side; "다시 확인").
// The app code can be changed by whoever has it, so this is not strong protection; the user knows.
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const PRODUCTION_URL = "https://korhrd-group-db.vercel.app/api/hanpyeongtok/license";
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_CHECK_SEC = 300;
const DEFAULT_GRACE_SEC = 86400;
// Shown when the first check at start takes longer than this, so the app does not look frozen.
const SHOW_WINDOW_AFTER_MS = 1500;
const CLOCK_SLACK_MS = 5 * 60 * 1000;
// When the office cannot be reached and the grace is over, try again after these delays before locking
// (a PC woken from sleep needs a moment to get back online).
const OFFLINE_RETRY_SEC = [10, 30];
const TOKEN_RE = /^hpt_[\x21-\x7e]{1,500}$/;

const TITLES = {
  invalid: "토큰이 올바르지 않습니다",
  revoked: "사용이 해제되었습니다",
  device_mismatch: "다른 PC에 등록된 토큰입니다",
  inactive_user: "사용할 수 없는 직원입니다",
};
const DEFAULT_MESSAGES = {
  invalid: "관리자에게 받은 토큰을 다시 넣어 주세요.",
  revoked: "관리자가 이 PC의 한평생톡 사용을 해제했습니다.",
  device_mismatch: "이 토큰은 다른 PC에서 이미 쓰고 있습니다. 관리자에게 해제한 뒤 새 토큰을 받아 주세요.",
  inactive_user: "관리자에게 문의해 주세요.",
};
const OFFLINE_ERROR = "오피스에 연결할 수 없습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.";

let log = console.log;
let logError = console.error;
let iconPath;
let licenseUrl = PRODUCTION_URL;
let deviceId = null;
let statePath = null;

/**
 * Saved between runs. On disk, everything is encrypted together with safeStorage ("sealed"), so the file cannot
 * be edited to stretch the offline grace or the time between checks.
 */
const state = { token: null, lastOkAt: 0, checkSec: DEFAULT_CHECK_SEC, graceSec: DEFAULT_GRACE_SEC };
/** performance.now() of the last success in this run; catches a clock set back while the app runs. */
let monoOkAt = null;

// ---- settings and storage ----

/**
 * NINETALK_LICENSE_URL changes the office address (a local office for tests). An installed app takes only an
 * https address there, so a fake local "office" cannot be put in front of it with one environment variable;
 * `npm start` also takes http://localhost.
 */
function resolveUrl() {
  const raw = process.env.NINETALK_LICENSE_URL;
  if (!raw) return PRODUCTION_URL;
  try {
    const url = new URL(raw);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol === "https:" || (!app.isPackaged && url.protocol === "http:" && local)) return url.href;
  } catch {
    // fall through
  }
  logError("NINETALK_LICENSE_URL is not an allowed address; using the office address");
  return PRODUCTION_URL;
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** This PC's id: made on the first run and kept in the app data folder. A new id looks like another PC. */
function loadDeviceId(dir) {
  const file = path.join(dir, "device-id");
  try {
    const saved = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f-]{36}$/.test(saved)) return saved;
    logError("the saved device id is unreadable; making a new one (the office will see a new PC)");
  } catch (error) {
    if (error.code !== "ENOENT") {
      // Could not read it (permissions?): do not replace it, or the office would see a new PC for good.
      logError("could not read the device id:", error.code);
      return null;
    }
  }
  const id = crypto.randomUUID();
  try {
    writeFileAtomic(file, `${id}\n`);
  } catch (error) {
    // An id that is not kept would change on the next run and the office would refuse it as another PC.
    logError("could not save the device id:", error.code);
    return null;
  }
  return id;
}

function loadState() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") logError("could not read the saved license:", error.code ?? error.name);
    return;
  }
  if (typeof saved?.sealed !== "string") return;
  try {
    const sealed = JSON.parse(safeStorage.decryptString(Buffer.from(saved.sealed, "base64")));
    if (typeof sealed?.token === "string" && TOKEN_RE.test(sealed.token)) state.token = sealed.token;
    if (Number.isFinite(sealed?.lastOkAt) && sealed.lastOkAt > 0) state.lastOkAt = sealed.lastOkAt;
    state.checkSec = clampSec(sealed?.checkSec, 60, 3600, DEFAULT_CHECK_SEC);
    state.graceSec = clampSec(sealed?.graceSec, 0, 7 * 86400, DEFAULT_GRACE_SEC);
  } catch {
    // e.g. Mac Keychain access denied, or the file came from another PC/user
    logError("could not decrypt the saved token; asking for it again");
  }
}

function saveState() {
  let sealed = null;
  if (state.token) {
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const { token, lastOkAt, checkSec, graceSec } = state;
        const plain = JSON.stringify({ token, lastOkAt, checkSec, graceSec });
        sealed = safeStorage.encryptString(plain).toString("base64");
      } catch {
        logError("could not encrypt the token; it is kept for this run only");
      }
    } else {
      logError("encryption is not available; the token is kept for this run only");
    }
  }
  try {
    writeFileAtomic(statePath, JSON.stringify({ sealed }));
  } catch (error) {
    logError("could not save the license:", error.code ?? error.name);
  }
}

function clampSec(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function recordOk(result) {
  state.lastOkAt = Date.now();
  monoOkAt = performance.now();
  state.checkSec = result.checkSec;
  state.graceSec = result.graceSec;
  saveState();
}

/** The office said no: the offline grace must not keep the app open on the strength of an older success. */
function recordDenied() {
  state.lastOkAt = 0;
  monoOkAt = null;
  saveState();
}

/** May the app keep working without the office? */
function offlineGrace() {
  if (!state.lastOkAt) return { ok: false, why: "never" };
  const now = Date.now();
  // A few minutes of slack: the clock being corrected by a few seconds after a success is not a clock set back.
  if (now < state.lastOkAt - CLOCK_SLACK_MS) return { ok: false, why: "clock" };
  // The larger of the two, so setting the clock back while the app runs does not stretch the grace
  // (performance.now() may stand still while the PC sleeps, so the wall clock still counts).
  let elapsed = Math.max(0, now - state.lastOkAt);
  if (monoOkAt !== null) elapsed = Math.max(elapsed, performance.now() - monoOkAt);
  return elapsed <= state.graceSec * 1000 ? { ok: true } : { ok: false, why: "expired" };
}

// ---- the office ----

/** One check. The result depends only on the status code; reason is read on 403 only. */
async function askOffice(token) {
  let res;
  let body = null;
  try {
    res = await fetch(licenseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        deviceId,
        deviceName: os.hostname(),
        platform: process.platform,
        appVersion: app.getVersion(),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    body = await res.json().catch(() => null);
  } catch (error) {
    return { kind: "offline", detail: error?.cause?.code ?? error?.name ?? "error" };
  }
  if (res.status === 200) {
    return {
      kind: "ok",
      checkSec: clampSec(body?.checkAfterSec, 60, 3600, DEFAULT_CHECK_SEC),
      graceSec: clampSec(body?.offlineGraceSec, 0, 7 * 86400, DEFAULT_GRACE_SEC),
    };
  }
  if (res.status === 403) {
    const reason = Object.hasOwn(TITLES, body?.reason) ? body.reason : "unknown";
    const text = typeof body?.message === "string" ? body.message.trim().slice(0, 300) : "";
    return { kind: "denied", reason, message: text || DEFAULT_MESSAGES[reason] || "관리자에게 문의해 주세요." };
  }
  return { kind: "offline", detail: `HTTP ${res.status}` };
}

// ---- views (what the license window shows) ----

const enterView = () => ({
  title: "한평생톡 사용 허가",
  message: "관리자에게 받은 사용 허가 토큰(hpt_ 로 시작)을 넣어 주세요.",
  showInput: true,
});

function deniedView(result) {
  return {
    title: TITLES[result.reason] ?? "사용할 수 없습니다",
    message: result.message,
    showInput: result.reason === "invalid",
    canReenter: true,
    canRecheck: Boolean(state.token),
  };
}

function offlineView(why) {
  const hours = state.graceSec / 3600;
  const span = hours >= 1 ? `${Math.floor(hours)}시간` : `${Math.max(1, Math.floor(state.graceSec / 60))}분`;
  const messages = {
    never: "사용 허가를 확인하려면 인터넷 연결이 필요합니다. 연결을 확인한 뒤 「다시 확인」을 눌러 주세요.",
    expired: `오피스에 ${state.graceSec >= 60 ? `${span} 넘게 ` : ""}연결되지 않아 잠겼습니다. 인터넷 연결을 확인한 뒤 「다시 확인」을 눌러 주세요.`,
    clock: "PC 시계가 마지막으로 확인한 시각보다 이전으로 되어 있습니다. 시계를 맞추고 인터넷에 연결한 뒤 「다시 확인」을 눌러 주세요.",
  };
  return {
    title: why === "clock" ? "PC 시계를 확인해 주세요" : "오피스에 연결할 수 없습니다",
    message: messages[why],
    canReenter: true,
    canRecheck: Boolean(state.token),
  };
}

const startingView = () => ({ title: "한평생톡", message: "", busy: true, busyText: "시작하는 중…" });

// ---- the license window ----

let win = null;
let view = null;
/** Resolved when the user gets past the window (a check succeeded). */
let waiter = null;
let busy = false;
let closingByApp = false;

function setView(next) {
  view = next;
  if (win && !win.isDestroyed()) {
    win.setClosable(!view.blockQuit);
    win.webContents.send("license:view", view);
  }
  return view;
}

function openWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 480,
    height: 440,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "한평생톡 사용 허가",
    icon: iconPath,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setClosable(!view?.blockQuit);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => {
    win = null;
    // Closing the window instead of getting past it means quitting.
    if (!closingByApp && waiter) app.quit();
    closingByApp = false;
  });
  win.loadFile(path.join(__dirname, "window.html"));
}

/** Shows the window with this view; resolves once a check succeeds from it. */
function showWindow(next) {
  if (!waiter) {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    waiter = { promise, resolve };
  }
  setView(next);
  // The app may be hidden (Cmd+H) or behind another app; the lock must be seen.
  if (process.platform === "darwin") app.focus({ steal: true });
  openWindow();
  return waiter.promise;
}

/** Past the window: it shows "시작하는 중" until closeWindow(), so the app always has a window open. */
function unlock() {
  const done = waiter;
  waiter = null;
  setView(startingView());
  done?.resolve();
}

function closeWindow() {
  if (waiter || !win || win.isDestroyed()) return;
  closingByApp = true;
  win.close();
}

function focusWindow() {
  if (!win || win.isDestroyed()) return false;
  openWindow();
  return true;
}

function fromWindow(event) {
  return win && !win.isDestroyed() && event.sender === win.webContents;
}

/** Runs one check for a button in the window, one at a time. */
async function busyCheck(work) {
  if (busy || !waiter || view?.busy) return view;
  busy = true;
  const before = view;
  setView({ ...before, busy: true, busyText: "오피스에 확인하는 중…", error: null });
  try {
    return await work(before);
  } catch (error) {
    logError("license check failed:", error?.message ?? error);
    return setView({ ...before, error: OFFLINE_ERROR });
  } finally {
    busy = false;
  }
}

function registerIpc() {
  ipcMain.handle("license:view", (event) => (fromWindow(event) ? view : null));

  ipcMain.handle("license:submit", (event, raw) => {
    if (!fromWindow(event)) return null;
    if (busy || !waiter || view?.busy) return view;
    const token = typeof raw === "string" ? raw.trim() : "";
    if (!TOKEN_RE.test(token)) {
      return setView({ ...view, showInput: true, error: "토큰은 hpt_ 로 시작합니다. 받은 그대로 붙여 넣어 주세요." });
    }
    return busyCheck(async (before) => {
      const result = await askOffice(token);
      if (result.kind === "ok") {
        state.token = token;
        recordOk(result);
        log("license: allowed (new token)");
        unlock();
        return view;
      }
      if (result.kind === "denied") {
        log("license: new token refused:", result.reason);
        // The saved token stays as it was. If it is the same token, the office has just refused it too.
        if (token === state.token) recordDenied();
        return setView({ ...deniedView(result), showInput: true });
      }
      log("license: office not reachable:", result.detail);
      return setView({ ...before, showInput: true, error: OFFLINE_ERROR });
    });
  });

  ipcMain.handle("license:recheck", (event) => {
    if (!fromWindow(event) || !state.token) return view;
    return busyCheck(async (before) => {
      const result = await askOffice(state.token);
      if (result.kind === "ok") {
        recordOk(result);
        log("license: allowed");
        unlock();
        return view;
      }
      if (result.kind === "denied") {
        log("license: refused:", result.reason);
        recordDenied();
        return setView(deniedView(result));
      }
      log("license: office not reachable:", result.detail);
      if (offlineGrace().ok) {
        unlock();
        return view;
      }
      return setView({ ...before, error: OFFLINE_ERROR });
    });
  });

  ipcMain.handle("license:quit", (event) => {
    if (fromWindow(event) && !view?.blockQuit) app.quit();
  });
}

// ---- checks while the app runs ----

let timer = null;
let onLock = null;
let checking = null;
let offlineRetries = 0;

function schedule(sec) {
  clearTimeout(timer);
  timer = setTimeout(runCheck, sec * 1000);
}

function runCheck() {
  if (!onLock || checking) return checking;
  checking = (async () => {
    const result = await askOffice(state.token);
    if (!onLock) return; // stopped meanwhile
    if (result.kind !== "offline") offlineRetries = 0;
    if (result.kind === "ok") {
      recordOk(result);
      schedule(state.checkSec);
      return;
    }
    if (result.kind === "denied") {
      log("license: refused while running:", result.reason);
      recordDenied();
      lockNow(deniedView(result));
      return;
    }
    const grace = offlineGrace();
    if (grace.ok) {
      offlineRetries = 0;
      log("license: office not reachable, still within the offline grace:", result.detail);
      schedule(state.checkSec);
      return;
    }
    if (offlineRetries < OFFLINE_RETRY_SEC.length) {
      log("license: office not reachable and the offline grace is over; trying again shortly");
      schedule(OFFLINE_RETRY_SEC[offlineRetries++]);
      return;
    }
    offlineRetries = 0;
    log("license: office not reachable and the offline grace is over:", grace.why);
    lockNow(offlineView(grace.why));
  })()
    .catch((error) => {
      logError("license check failed:", error?.message ?? error);
      if (onLock) schedule(state.checkSec);
    })
    .finally(() => {
      checking = null;
    });
  return checking;
}

function lockNow(lockView) {
  const handler = onLock;
  stopChecks();
  handler?.(lockView);
}

/** Checks every checkSec while the app runs; handler(lockView) is called once when it must lock. */
function startChecks(handler) {
  if (process.env.NINETALK_SKIP_LICENSE === "1" && !app.isPackaged) return;
  onLock = handler;
  schedule(state.checkSec);
}

function stopChecks() {
  onLock = null;
  clearTimeout(timer);
  timer = null;
}

/** After the PC wakes from sleep: check soon instead of waiting out the timer. */
function checkSoon() {
  if (onLock && !checking) schedule(5);
}

// ---- entry points for main.js ----

function init(options) {
  log = options.log ?? log;
  logError = options.logError ?? logError;
  iconPath = options.iconPath;
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  statePath = path.join(dir, "license.json");
  licenseUrl = resolveUrl();
  deviceId = loadDeviceId(dir);
  loadState();
  registerIpc();
  // A window that cannot be closed (the "멈추는 중" view) must not hold up quitting.
  app.on("before-quit", () => {
    if (win && !win.isDestroyed()) win.setClosable(true);
  });
}

/**
 * At start: resolves once the app may run. Shows the token window when there is no token, and the lock
 * window when the office refuses or cannot be reached past the offline grace. Closing the window quits.
 */
async function startup() {
  if (process.env.NINETALK_SKIP_LICENSE === "1" && !app.isPackaged) {
    log("license: skipped (NINETALK_SKIP_LICENSE=1, development only)");
    return;
  }
  if (!deviceId) {
    // Without a stable id every check would look like a new PC; say so instead of locking with a wrong reason.
    await showWindow({
      title: "한평생톡을 시작할 수 없습니다",
      message: "이 PC의 고유 번호를 읽지 못했습니다. 앱 데이터 폴더 권한을 확인한 뒤 앱을 다시 실행해 주세요.",
    });
    return;
  }
  if (!state.token) {
    log("license: no token yet");
    await showWindow(enterView());
    return;
  }
  const check = askOffice(state.token);
  const slow = setTimeout(() => {
    setView({ title: "한평생톡", message: "", busy: true, busyText: "오피스에서 사용 허가를 확인하는 중…" });
    openWindow();
  }, SHOW_WINDOW_AFTER_MS);
  const result = await check.finally(() => clearTimeout(slow));
  if (result.kind === "ok") {
    recordOk(result);
    log("license: allowed");
    if (win) setView(startingView());
    return;
  }
  if (result.kind === "denied") {
    log("license: refused:", result.reason);
    recordDenied();
    await showWindow(deniedView(result));
    return;
  }
  const grace = offlineGrace();
  if (grace.ok) {
    log("license: office not reachable, within the offline grace:", result.detail);
    if (win) setView(startingView());
    return;
  }
  log("license: office not reachable and no offline grace:", grace.why, result.detail);
  await showWindow(offlineView(grace.why));
}

/**
 * Lock while running: first a busy view that cannot be closed (main.js finishes the recipient in progress
 * meanwhile), then lockView via showLock(). Resolves when the user gets past it.
 */
function showStopping(lockView) {
  return showWindow({ ...lockView, busy: true, busyText: "보내던 사람까지 보내고 멈추는 중입니다…", blockQuit: true, canReenter: false, canRecheck: false, showInput: false });
}

function showLock(lockView) {
  return showWindow(lockView);
}

module.exports = { init, startup, startChecks, stopChecks, checkSoon, showStopping, showLock, closeWindow, focusWindow };
