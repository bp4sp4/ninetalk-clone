// Electron shell for the dashboard: runs the Next standalone server (../web) on 127.0.0.1:47300 and
// shows it in a window. It also starts the PC program unless one is already running: ../daemon on
// Windows, ../daemon-mac on Mac (NINETALK_MOCK_DAEMON=1 starts the mock daemon instead, for development).
// Nothing starts until the office allows this PC (./license, 오피스 사용 허가 토큰).
const { app, BrowserWindow, dialog, powerMonitor, session, shell, systemPreferences, utilityProcess } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const license = require("./license");

const HOST = "127.0.0.1";
const PORT = 47300;
const APP_ORIGIN = `http://${HOST}:${PORT}`;
const DAEMON_URL = "http://localhost:47301";

// Packaged: scripts/after-pack.cjs copies these into resources/. Unpackaged (npm start): ./build.
const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, "build");
const WEB_DIR = path.join(resources, "web");
const DAEMON_EXE = path.join(resources, "daemon", "NineTalkDaemon.exe");
const MAC_DAEMON_DIR = path.join(resources, "daemon-mac");
const MOCK_DAEMON = path.join(__dirname, "..", "web", "scripts", "mock-daemon.mjs");
const USE_MOCK = process.env.NINETALK_MOCK_DAEMON === "1";

/** Child processes started here, each with how to stop it. */
const children = [];
let mainWindow = null;
let quitting = false;
/** Set once the user has agreed to quit (or nothing was being sent), so the window may close. */
let allowQuit = false;
/** Bumped each time the web server and PC program are started or stopped; a start in progress from an older run gives up. */
let servicesRun = 0;
/** True while locking (the office said no): the recipient in progress is being finished. */
let locking = false;
/** The user asked to quit while locking: quit once that is done instead of showing the lock window. */
let quitAfterLock = false;
/** Set from the moment the office says no until the services start again: the dashboard may not start a send. */
let blockSends = false;

function log(...args) {
  console.log("[ninetalk]", ...args);
}

// On Windows the app's own problems go to the PC program's errors.log too ([앱]), so one file covers everything.
const ERROR_LOG = process.platform === "win32" && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "NineTalkDaemon", "errors.log")
  : null;
function logError(...args) {
  log(...args);
  if (!ERROR_LOG) return;
  try {
    fs.mkdirSync(path.dirname(ERROR_LOG), { recursive: true });
    const stamp = new Date().toLocaleString("sv-SE"); // 2026-11-24 17:30:00
    fs.appendFileSync(ERROR_LOG, `${stamp} [앱] ${args.map(String).join(" ")}\r\n`);
  } catch {
    // the log must never break the app
  }
}
process.on("uncaughtException", (error) => {
  logError("app error:", error?.stack ?? error);
  if (app.isReady()) dialog.showErrorBox("한평생톡", `예상하지 못한 오류가 났습니다.\n\n${error?.message ?? error}`);
});

/**
 * Environment for child processes. NODE_OPTIONS (e.g. --inspect, --require) from the user's PC would
 * change how the bundled server starts, so it is not passed on.
 */
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NINETALK_MAC_PORT; // a test-only port: the dashboard always calls 47301
  return env;
}

/** True when something is already listening on the app port. */
function portInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, HOST);
  });
}

/**
 * What is on the daemon port: "daemon" (a NineTalk PC program or mock answers /status), "free"
 * (nothing listening), or "other" (some other program holds the port).
 */
async function probeDaemon() {
  try {
    const res = await fetch(`${DAEMON_URL}/status`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json().catch(() => null);
    return res.ok && body && typeof body.status === "string" ? "daemon" : "other";
  } catch (error) {
    // localhost is tried as both ::1 and 127.0.0.1, so the refusal can come wrapped in an AggregateError.
    // An address family that is switched off on this PC (no IPv6 loopback) does not mean the port is taken.
    const cause = error?.cause;
    const codes = cause?.errors?.map((e) => e.code) ?? [cause?.code];
    const unreachable = new Set(["EADDRNOTAVAIL", "ENETUNREACH", "EAFNOSUPPORT", "EHOSTUNREACH"]);
    const free = codes.includes("ECONNREFUSED") && codes.every((code) => code === "ECONNREFUSED" || unreachable.has(code));
    return free ? "free" : "other";
  }
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function waitForExit(onExit, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    onExit(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function startWebServer() {
  const dataDir = path.join(app.getPath("userData"), "data");
  const child = utilityProcess.fork(path.join(WEB_DIR, "server.js"), [], {
    cwd: WEB_DIR,
    serviceName: "NineTalk web server",
    stdio: "pipe",
    env: childEnv({
      NODE_ENV: "production",
      PORT: String(PORT),
      HOSTNAME: HOST,
      NINETALK_LOCAL_MODE: "1",
      NINETALK_DATA_DIR: dataDir,
      NODE_NO_WARNINGS: "1",
    }),
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[web] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[web] ${d}`));
  let exited = false;
  let stopping = false;
  const onExit = (cb) => (exited ? cb() : child.once("exit", cb));
  child.on("exit", (code) => {
    exited = true;
    log("web server exited", code);
    if (!quitting && !stopping) {
      logError("web server stopped unexpectedly, code", code);
      dialog.showErrorBox("한평생톡", `내부 서버가 종료되었습니다 (코드 ${code}). 앱을 다시 실행해 주세요.`);
      // Nothing can record send results without the server; the PC program keeps its last results for next time.
      allowQuit = true;
      app.quit();
    }
  });
  children.push({
    name: "web server",
    stop: async () => {
      stopping = true;
      if (exited) return;
      child.kill();
      // The port must be free before it is started again (after a lock): force it if it does not exit.
      if (!(await waitForExit(onExit, 3000)) && child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // already gone
        }
        await waitForExit(onExit, 2000);
      }
    },
  });
  log("data folder:", dataDir);
}

/** Asks the PC program (or mock) to exit normally, so it removes its tray icon and restores KakaoTalk. */
async function requestDaemonShutdown() {
  try {
    await fetch(`${DAEMON_URL}/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // already gone, or an older daemon without /shutdown: the caller falls back to kill()
  }
}

// Longest a PC program can need to finish its last recipient (5 files with slow uploads, then closing the chat:
// the Mac program allows 2 min + 2 min a file, ../daemon-mac/server.mjs).
const LAST_RECIPIENT_MS = 13 * 60 * 1000;

async function startDaemon(run) {
  // The app is closing or locking: do not start a PC program nothing would stop.
  const cancelled = () => quitting || run !== servicesRun;
  let found = await probeDaemon();
  // A PC program from the previous run may still be finishing its last recipient. Wait for it to exit and
  // start a fresh one: adopting it would leave this app with no PC program once it exits a moment later.
  // The window is already open meanwhile (the sidebar shows the old one as "종료 중").
  const waitUntil = Date.now() + LAST_RECIPIENT_MS;
  let waited = false;
  while (found === "daemon" && !cancelled()) {
    const shuttingDown = await daemonJson("/status").then((s) => s.shutting_down === true || s.status === "ShuttingDown").catch(() => null);
    if (shuttingDown === null) {
      // No answer: it may have just exited. Look at the port again instead of assuming it is still there.
      if (Date.now() > waitUntil) {
        logError("the PC program on the port does not answer; not starting another one (restart the app later)");
        return;
      }
      await sleep(300);
      found = await probeDaemon();
      continue;
    }
    if (!shuttingDown) break;
    if (!waited) log("the previous PC program is still finishing its last recipient; waiting for it to exit");
    waited = true;
    if (Date.now() > waitUntil) {
      logError("the previous PC program did not exit in time; not starting another one (restart the app later)");
      return;
    }
    await sleep(1000);
    found = await probeDaemon();
  }
  if (waited && found !== "daemon") log("the previous PC program has exited");
  if (cancelled()) return;
  if (found === "daemon") {
    // Started by hand (dotnet run, mock-daemon): leave it alone. Its default allowed origins include APP_ORIGIN.
    log("using the PC program that is already running on", DAEMON_URL);
    return;
  }
  if (found === "other") {
    logError(`${DAEMON_URL} is held by another program; not starting the PC program`);
    dialog.showErrorBox(
      "한평생톡",
      "PC 프로그램 포트(47301)를 다른 프로그램이 쓰고 있어 PC 프로그램을 시작하지 못했습니다.\n친구 불러오기와 발송은 쓸 수 없습니다.",
    );
    return;
  }
  const env = childEnv({ NINETALK_ALLOWED_ORIGINS: APP_ORIGIN, MOCK_DAEMON_ORIGINS: APP_ORIGIN });

  if (process.platform === "win32") {
    if (!fs.existsSync(DAEMON_EXE)) {
      logError("PC program not found:", DAEMON_EXE);
      return;
    }
    // --parent-pid: the daemon exits by itself if this app dies without stopping it (crash, Task Manager).
    const child = spawn(DAEMON_EXE, ["--parent-pid", String(process.pid)], { env, stdio: "ignore", windowsHide: true });
    let exited = false;
    let stopping = false;
    const onExit = (cb) => (exited ? cb() : child.once("exit", cb));
    child.once("exit", (code) => {
      exited = true;
      if (!quitting && !stopping) logError("PC program exited while the app was running, code", code);
    });
    child.on("error", (e) => {
      // A failed spawn may never emit "exit"; do not wait for it on quit.
      exited = true;
      logError("PC program failed to start:", e.message);
    });
    children.push({
      name: "PC program",
      stop: async () => {
        stopping = true;
        if (exited) return;
        await requestDaemonShutdown();
        if (!(await waitForExit(onExit, 3000))) child.kill();
      },
    });
    return;
  }

  const macServer = path.join(MAC_DAEMON_DIR, "server.mjs");
  const macBinary = path.join(MAC_DAEMON_DIR, "kakao-mac");
  if (process.platform === "darwin" && !USE_MOCK && fs.existsSync(macServer) && fs.existsSync(macBinary)) {
    // KakaoTalk is driven through the Accessibility API; macOS asks the user once to allow this app.
    if (!systemPreferences.isTrustedAccessibilityClient(true)) {
      log("Accessibility permission not granted yet; the dashboard shows it until it is allowed");
    }
    spawnMacDaemon(macServer, {
      ...env,
      KAKAO_MAC_BIN: macBinary,
      NINETALK_MAC_STATE_DIR: path.join(app.getPath("userData"), "daemon-mac"),
    });
    return;
  }

  // Development without the real PC program: fake it.
  if (!app.isPackaged && fs.existsSync(MOCK_DAEMON)) {
    if (process.platform === "darwin" && !USE_MOCK) log("Mac PC program not built (npm run build:daemon-mac); using the mock daemon");
    forkNodeDaemon(MOCK_DAEMON, "mock daemon", "mock", env);
  }
}

/**
 * Runs the Mac PC program as a direct child of this app: the app's own executable in Node mode
 * (ELECTRON_RUN_AS_NODE). Not a utility process, because Electron's helper processes are their own
 * "responsible" process for macOS privacy checks, so the Accessibility permission the user grants to
 * this app would not cover kakao-mac (it reported NoAccessibility with the app allowed).
 */
// Note: this needs Electron's RunAsNode fuse (on by default); do not turn that fuse off in the build.
function spawnMacDaemon(script, env) {
  const child = spawn(process.execPath, [script], {
    // NINETALK_PARENT_PID: the daemon exits by itself when this app is gone (crash, force quit).
    env: { ...env, ELECTRON_RUN_AS_NODE: "1", NINETALK_PARENT_PID: String(process.pid) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  watchDaemonChild(child, "Mac PC program", "mac");
}

/** Runs the mock daemon in a utility process (development only). */
function forkNodeDaemon(script, name, prefix, env) {
  const child = utilityProcess.fork(script, [], { env, stdio: "pipe", serviceName: `NineTalk ${name}` });
  watchDaemonChild(child, name, prefix);
}

/** Pipes a Node daemon's output and stops it with POST /shutdown (kill after 3 s) when the app quits. */
function watchDaemonChild(child, name, prefix) {
  child.stdout?.on("data", (d) => process.stdout.write(`[${prefix}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[${prefix}] ${d}`));
  let exited = false;
  const onExit = (cb) => (exited ? cb() : child.once("exit", cb));
  child.once("exit", (code) => {
    exited = true;
    log(`${name} exited`, code ?? "");
  });
  child.on?.("error", (e) => {
    exited = true;
    log(`${name} failed:`, e?.message ?? e?.type ?? e);
  });
  children.push({
    name,
    stop: async () => {
      if (exited) return;
      await requestDaemonShutdown();
      // The Mac PC program finishes the recipient it is sending to before it exits.
      if (!(await waitForExit(onExit, 3000))) child.kill();
    },
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "한평생톡",
    icon: path.join(__dirname, "icons", "icon.png"),
    autoHideMenuBar: true,
    // backgroundThrottling off: the 발송 내역 page must keep polling and recording results while the window
    // is covered by other apps (a send can run for a long time in the background).
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });

  // Only the dashboard runs inside the window; any other link opens in the user's browser.
  const isAppUrl = (url) => url.startsWith(`${APP_ORIGIN}/`) || url === APP_ORIGIN;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });

  // If the server briefly does not answer, retry instead of leaving a blank window.
  let retries = 0;
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, _description, url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 /* ERR_ABORTED: a navigation replaced this one */ || quitting) return;
    if (retries++ >= 5) {
      logError("the window could not load", url, errorCode);
      dialog.showErrorBox("한평생톡", "화면을 불러오지 못했습니다. 앱을 다시 실행해 주세요.");
      return;
    }
    setTimeout(() => mainWindow?.loadURL(isAppUrl(url) ? url : `${APP_ORIGIN}/dashboard`), 1000);
  });
  mainWindow.webContents.on("did-finish-load", () => {
    retries = 0;
  });

  mainWindow.on("close", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (locking) {
      quitAfterLock = true; // the lock is already finishing the recipient in progress
      return;
    }
    quitAfterCheck();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL(`${APP_ORIGIN}/dashboard`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function daemonJson(pathname, init) {
  const res = await fetch(`${DAEMON_URL}${pathname}`, { ...init, signal: AbortSignal.timeout(2000) });
  return res.json();
}

/**
 * Quitting while the PC program is sending: ask first. When the user agrees, stop after the recipient in
 * progress and keep the window open until the dashboard has recorded the results; otherwise someone who did
 * get the message could stay "pending" and get it a second time on the next send.
 */
let quitCheck = null;
function confirmQuitWhileSending() {
  quitCheck ??= (async () => {
    let status;
    try {
      status = (await daemonJson("/status")).status;
    } catch {
      return true; // no PC program answering: nothing is being sent
    }
    if (status !== "SendMessage" || !mainWindow || mainWindow.isDestroyed()) return true;
    // The question is a sheet on the window: a minimized or hidden window would hide it, and the app would just
    // seem stuck. The window also has to be in front for the 발송 내역 page to record results afterwards.
    if (process.platform === "darwin") app.focus({ steal: true }); // the app may be hidden (Cmd+H) or behind another app
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: ["보내던 사람까지 보내고 종료", "계속 보내기"],
      defaultId: 1,
      cancelId: 1,
      title: "한평생톡",
      message: "메시지를 보내는 중입니다.",
      detail: "종료하면 지금 보내던 사람까지만 보내고 멈춘 뒤, 결과를 발송 내역에 기록하고 앱을 닫습니다.",
    });
    if (response !== 0) return false;
    await finishLastRecipient();
    return true;
  })().finally(() => {
    quitCheck = null;
  });
  return quitCheck;
}

/** Stops the send after the recipient in progress and waits until the 발송 내역 page has recorded the results. */
async function finishLastRecipient() {
  // Results are copied to the dashboard's database by the 발송 내역 page. Load it afresh even when it is
  // already showing: its polling may have given up ("연결이 끊어졌습니다"), and a fresh load picks the run up again.
  mainWindow?.loadURL(`${APP_ORIGIN}/jobs`).catch(() => {});
  await daemonJson("/send/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  // Up to the PC program's own worst case for one recipient, so the last result is not lost to a cut-off.
  const deadline = Date.now() + LAST_RECIPIENT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await daemonJson("/send/result")).state !== "running") break;
    } catch {
      break;
    }
    await sleep(500);
  }
  // The dashboard reads /send/result every 1.5 s; give it time to record the last results.
  await sleep(4000);
}

/**
 * The office said no while the app runs (or could not be reached past the offline grace): finish the recipient
 * in progress, stop the web server and PC program, and show the lock window. If the user gets past it (a new
 * token, or 다시 확인), start everything again.
 */
async function lockWhileRunning(lockView) {
  if (locking) return;
  blockSends = true;
  // A quit question may be open: let the user answer it first (quitting makes the lock moot). Not locking yet
  // meanwhile, or before-quit would hold the quit the user just agreed to. The send must not run on until the
  // user comes back to answer, so stop it after the recipient in progress now.
  if (quitCheck) {
    await daemonJson("/send/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
    await quitCheck.catch(() => {});
  }
  if (quitting || allowQuit || locking) return;
  locking = true;
  try {
    logError("the office no longer allows this PC; locking");
    const unlocked = license.showStopping(lockView);
    // No new sends from the dashboard meanwhile (blockSends makes the POST /send blocker in main() refuse them);
    // the window keeps running so it can record the last results.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.setEnabled(false);
    }
    // A send the dashboard sent just before may only now be starting: wait a moment. Then always go through
    // 발송 내역 (stop, wait for the last recipient, let the page record): a run stopped early (a quit question was
    // open) or one that just ended may not be recorded yet either. A stop request while nothing is sending does
    // nothing (each send starts with a fresh stop flag in both PC programs).
    await sleep(1500);
    if (mainWindow && !mainWindow.isDestroyed()) await finishLastRecipient();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy(); // not close(): that asks about quitting
    mainWindow = null;
    await stopServices();
    if (quitAfterLock) {
      allowQuit = true;
      locking = false; // before app.quit(): before-quit would hold the quit again while locking
      app.quit();
      return;
    }
    license.showLock(lockView);
    locking = false;
    await unlocked;
    if (quitting) return;
    log("allowed again; starting");
    blockSends = false;
    if (await startServices()) {
      license.closeWindow();
      startLicenseChecks();
    }
  } finally {
    locking = false;
  }
}

/** Checks the license while the app runs; locks through lockWhileRunning. */
function startLicenseChecks() {
  license.startChecks((lockView) => {
    lockWhileRunning(lockView).catch(async (error) => {
      // Do not leave the user with a lock window that cannot be closed: quit, after the recipient in progress.
      logError("locking failed:", error?.stack ?? error);
      if (mainWindow && !mainWindow.isDestroyed()) await finishLastRecipient().catch(() => {});
      locking = false;
      allowQuit = true;
      app.quit();
    });
  });
}

function quitAfterCheck() {
  confirmQuitWhileSending().then((ok) => {
    if (!ok) return;
    allowQuit = true;
    app.quit();
  });
}

/** Stops children in reverse start order (PC program first, so it can finish restoring KakaoTalk). */
async function stopChildren() {
  quitting = true;
  await stopServices();
}

async function stopServices() {
  servicesRun++;
  for (const child of children.splice(0).reverse()) {
    try {
      await child.stop();
    } catch (error) {
      log(`stopping ${child.name} failed:`, error?.message);
    }
  }
}

async function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (license.focusWindow() || !mainWindow) return; // the token or lock window, when it is up
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => app.quit());
  // Hold the quit until children have stopped (the PC program needs a moment to exit normally).
  let stopped = false;
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    if (quitting) return;
    if (locking) {
      // The recipient in progress is being finished for the lock; quit right after that.
      quitAfterLock = true;
      return;
    }
    if (mainWindow && !allowQuit) {
      quitAfterCheck();
      return;
    }
    stopChildren().finally(() => {
      stopped = true;
      app.quit();
    });
  });

  await app.whenReady();

  if (!fs.existsSync(path.join(WEB_DIR, "server.js"))) {
    dialog.showErrorBox("한평생톡", `웹 빌드를 찾지 못했습니다: ${WEB_DIR}\n\ndesktop 폴더에서 npm run build:web 을 먼저 실행하세요.`);
    app.quit();
    return;
  }

  license.init({ iconPath: path.join(__dirname, "icons", "icon.png"), log, logError });
  // While locking, the dashboard must not start a new send (the PC program would be stopped in the middle of it).
  // Both spellings of the PC program's address, in case the dashboard is built with 127.0.0.1.
  const sendUrls = ["http://localhost:47301/send*", "http://127.0.0.1:47301/send*"];
  session.defaultSession.webRequest.onBeforeRequest({ urls: sendUrls }, (details, callback) => {
    const startsSend = details.method === "POST" && new URL(details.url).pathname === "/send";
    callback({ cancel: blockSends && startsSend });
  });
  // Shows the token or lock window when needed; the web server and PC program do not start before this.
  await license.startup();
  if (quitting) return;
  if (!(await startServices())) return;
  license.closeWindow();
  startLicenseChecks();
  powerMonitor.on("resume", () => license.checkSoon());
}

/** Starts the web server and PC program and opens the dashboard window. False when the app is quitting instead. */
async function startServices() {
  const run = ++servicesRun;
  // After a lock the old web server has only just let the port go: look a few times before giving up.
  let busyPort = await portInUse(PORT);
  for (let i = 0; busyPort && i < 10; i++) {
    await sleep(500);
    busyPort = await portInUse(PORT);
  }
  if (quitting || run !== servicesRun) return false;
  if (busyPort) {
    logError(`port ${PORT} is in use; the app cannot start`);
    dialog.showErrorBox("한평생톡", `${PORT} 포트를 다른 프로그램이 쓰고 있어 시작할 수 없습니다.`);
    app.quit();
    return false;
  }

  startWebServer();
  // Not awaited: it can wait minutes for a previous PC program to finish, and the window must not stay
  // hidden that long. The dashboard shows the PC program's state as it comes up.
  startDaemon(run).catch((error) => logError("starting the PC program failed:", error?.message ?? error));

  if (!(await waitForServer(`${APP_ORIGIN}/dashboard`, 30000))) {
    logError("the web server did not start within 30 s");
    dialog.showErrorBox("한평생톡", "내부 서버가 30초 안에 시작되지 않았습니다.");
    app.quit();
    return false;
  }
  if (quitting || run !== servicesRun) return false;
  createWindow();
  return true;
}

main();
