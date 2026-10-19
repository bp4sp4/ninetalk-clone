// NineTalk PC program for Mac: the same local HTTP API as the Windows daemon (../DAEMON_API.md) on
// http://localhost:47301, driving KakaoTalk for Mac through ./build/kakao-mac (Accessibility API).
//
//   node server.mjs                       real sending
//   NINETALK_MAC_DRY_RUN=1 node server.mjs  every send is a dry run (opens the chat, types, clears, closes)
//
// Env: NINETALK_ALLOWED_ORIGINS (comma list), KAKAO_MAC_BIN (path to the kakao-mac binary),
// NINETALK_MAC_STATE_DIR (where the last send job is kept), NINETALK_MAC_PORT (tests).
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// NINETALK_MAC_PORT is only for testing next to another daemon; the dashboard always calls 47301.
const PORT = Number(process.env.NINETALK_MAC_PORT) || 47301;
const VERSION = "0.1.0-mac";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.KAKAO_MAC_BIN || path.join(HERE, "build", "kakao-mac");
const DRY_RUN = process.env.NINETALK_MAC_DRY_RUN === "1";
// Shown in the dashboard sidebar, so a forgotten dry-run setting is visible.
const VERSION_LABEL = DRY_RUN ? `${VERSION} (dry-run: 실제로 안 보냄)` : VERSION;
// This many failures in a row with the same cause mean something is wrong with KakaoTalk itself: stop the job.
const MAX_SAME_FAILURES = 3;
// The last send job survives a restart, so the dashboard can still record who already got the message.
const STATE_DIR = process.env.NINETALK_MAC_STATE_DIR || path.join(os.homedir(), "Library", "Application Support", "NineTalkMacDaemon");
const JOB_FILE = path.join(STATE_DIR, "last-send.json");
// localhost:3000 = web dev server, 127.0.0.1:47300 = the desktop app (../desktop).
const ALLOWED_ORIGINS = new Set(
  (process.env.NINETALK_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:47300")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
// Only these Host headers, so a rebinding DNS name cannot reach the API from a web page.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

// Pause after each recipient by speed_rate 1 (slowest) .. 5 (fastest), plus a random 0-3s; same as Windows.
const PAUSE_SECONDS = [0, 20, 14, 10, 7, 5];
const SPLIT_REST_SECONDS = 90;

function log(...args) {
  console.log(new Date().toLocaleTimeString("ko-KR"), ...args);
}

/** Error from kakao-mac itself; `detail` never contains the recipient's name or message. */
class KakaoMacError extends Error {
  constructor(detail) {
    super(`kakao-mac: ${detail}`);
    this.detail = detail;
  }
}

function runKakao(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(BIN, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) {
        // error.message repeats the command line (name and text), so only the cause is kept.
        const detail = error.killed
          ? "timeout"
          : error.code === "ENOENT" || error.code === "EACCES"
            ? "binary_not_found" // missing, or not executable: either way the install is broken
            : `exit_${error.code ?? error.signal ?? "unknown"}`;
        return reject(new KakaoMacError(detail));
      }
      let out;
      try {
        out = JSON.parse(stdout);
      } catch {
        return reject(new KakaoMacError("unexpected_output"));
      }
      if (!out || typeof out !== "object" || Array.isArray(out)) return reject(new KakaoMacError("unexpected_output"));
      resolve(out);
    });
  });
}

// KakaoTalk operations (status checks included) run strictly one after another: two kakao-mac processes
// would select rows and press keys in the same window.
let queue = Promise.resolve();
let queued = 0;
function kakao(args, timeoutMs) {
  queued++;
  const result = queue.then(() => runKakao(args, timeoutMs));
  queue = result.catch(() => {}).finally(() => queued--);
  return result;
}

// --- status -------------------------------------------------------------------------------------

let busy = null; // "GetKaoFriends" | "SendMessage" | null
let shuttingDown = false; // after /shutdown: no new jobs
let kakaoStatus = { value: "NotRunning", at: 0 };

let statusCheck = null; // the one status check in flight; concurrent /status requests share it

async function currentStatus() {
  if (busy) return busy;
  if (shuttingDown) return "ShuttingDown";
  // The dashboard polls /status every few seconds; a fresh check costs one short process, cache it briefly.
  if (Date.now() - kakaoStatus.at > 1500) {
    statusCheck ??= kakao(["status"], 5000)
      .then((out) => {
        // An answer without a status is a broken kakao-mac, not a KakaoTalk state.
        kakaoStatus = { value: typeof out.status === "string" ? out.status : "DaemonBroken", at: Date.now() };
      })
      .catch((error) => {
        log("status check failed:", error.message);
        // A missing or broken kakao-mac is not "KakaoTalk is off"; say what it is.
        const broken = ["binary_not_found", "unexpected_output"].includes(error.detail) || String(error.detail ?? "").startsWith("exit_");
        kakaoStatus = { value: broken ? "DaemonBroken" : "NotRunning", at: Date.now() };
      })
      .finally(() => {
        statusCheck = null;
      });
    await statusCheck;
  }
  return busy ?? (shuttingDown ? "ShuttingDown" : kakaoStatus.value);
}

// --- friends ------------------------------------------------------------------------------------

let sync = { count: 0, lastError: null, result: [], kakaoFriendCount: null };

async function runSync(keyword) {
  busy = "GetKaoFriends";
  sync = { count: 0, lastError: null, result: [], kakaoFriendCount: null };
  try {
    const out = await kakao(["friends"], 60000);
    if (out.result === "failed") {
      sync.lastError = `카카오톡 친구 목록을 읽지 못했습니다 (${out.detail ?? out.error})`;
      return;
    }
    // Start-search: KakaoTalk's search box is not touched (like the Windows daemon); filter the full list.
    if (!Array.isArray(out.friends)) {
      sync.lastError = "카카오톡 친구 목록을 읽지 못했습니다 (PC 프로그램 응답이 올바르지 않음)";
      return;
    }
    const names = out.friends.filter((name) => typeof name === "string" && (!keyword || name.includes(keyword)));
    sync.result = names;
    sync.count = names.length;
    sync.kakaoFriendCount = out.kakao_friend_count ?? null;
    log(`친구 읽기: ${out.friends.length}명${keyword ? `, 검색어 일치 ${names.length}명` : ""}`);
  } catch (error) {
    sync.lastError = `카카오톡 친구 목록을 읽지 못했습니다 (${error.message})`;
  } finally {
    busy = null;
  }
}

// --- sending ------------------------------------------------------------------------------------

let job = { job_id: null, state: "done", results: [], stopRequested: false, wake: null };

function saveJob() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const temp = `${JOB_FILE}.tmp`;
    writeFileSync(temp, JSON.stringify({ job_id: job.job_id, state: job.state, results: job.results }));
    renameSync(temp, JOB_FILE);
  } catch (error) {
    log("could not save the send job:", error.message);
  }
}

function loadJob() {
  try {
    const saved = JSON.parse(readFileSync(JOB_FILE, "utf8"));
    if (!Array.isArray(saved.results)) return;
    // Still "running" (or unreadable) means this program was stopped mid-job: nobody after the last result was sent to.
    const state = ["done", "stopped", "failed"].includes(saved.state) ? saved.state : "stopped";
    job = { ...job, job_id: saved.job_id ?? null, state, results: saved.results };
    log(`지난 발송 결과를 불러왔습니다: 요청 ${job.job_id}, ${job.results.length}명, ${job.state}`);
  } catch {
    // no earlier job
  }
}

function pause(seconds) {
  if (job.stopRequested) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    job.wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function runSend({ job_id, recipients, speed_rate, split_send_count }) {
  busy = "SendMessage";
  job = { job_id: job_id ?? null, state: "running", results: [], stopRequested: false, wake: null };
  saveJob();
  const speed = Math.min(5, Math.max(1, Number(speed_rate) || 3));
  log(`발송 시작: ${recipients.length}명${DRY_RUN ? " (dry-run, 실제로 보내지 않음)" : ""}`);
  let finalState = "done";
  let lastCause = null;
  let sameFailures = 0;
  try {
    for (const [i, recipient] of recipients.entries()) {
      if (job.stopRequested) {
        finalState = "stopped";
        break;
      }
      const args = ["send", String(recipient.name).trim(), String(recipient.text ?? "")];
      if (!DRY_RUN) args.push("--send");
      let out;
      try {
        out = await kakao(args, 60000);
      } catch (error) {
        out = { result: "failed", error: "send_failed", detail: error.detail ?? "error" };
      }
      const ok = out.result === "sent";
      // dry_run: nothing went out, so it must not be recorded as sent. input_not_empty: someone's unsent draft.
      const error = out.result === "dry_run_ok" ? "dry_run" : out.detail === "input_not_empty" ? "input_not_empty" : out.error;
      job.results.push(ok ? { id: recipient.id, status: "sent" } : { id: recipient.id, status: "failed", error });
      saveJob();
      log(`${i + 1}/${recipients.length}: ${ok ? out.result + (out.confirmed === false ? " (마지막 메시지 확인 못 함)" : "") : `failed ${error} ${out.detail ?? ""}`}`);
      if (!ok && out.error === "kakao_not_ready") {
        finalState = "failed";
        break;
      }
      // kakao-mac was killed or crashed midway: KakaoTalk's state is unknown, so do not go on to the next person.
      const brokenRun = ["timeout", "unexpected_output", "binary_not_found"].includes(out.detail) || String(out.detail ?? "").startsWith("exit_");
      if (!ok && brokenRun) {
        log("kakao-mac 이 끝까지 실행되지 않아 멈춥니다:", out.detail);
        finalState = "failed";
        break;
      }
      const cause = ok || out.result === "dry_run_ok" ? null : `${out.error}:${out.detail ?? ""}`;
      sameFailures = cause && cause === lastCause ? sameFailures + 1 : cause ? 1 : 0;
      lastCause = cause;
      if (sameFailures >= MAX_SAME_FAILURES && !["not_found", "duplicate_name", "input_not_empty"].includes(error)) {
        log(`같은 실패가 ${sameFailures}번 이어져 멈춥니다: ${cause}`);
        finalState = "failed";
        break;
      }
      if (job.stopRequested) {
        finalState = "stopped";
        break;
      }
      if (i === recipients.length - 1) break;
      let seconds = PAUSE_SECONDS[speed] + Math.random() * 3;
      if (split_send_count > 0 && (i + 1) % split_send_count === 0) seconds += SPLIT_REST_SECONDS;
      await pause(seconds);
    }
    if (job.stopRequested && finalState === "done" && job.results.length < recipients.length) finalState = "stopped";
  } finally {
    job.state = finalState;
    job.wake = null;
    saveJob();
    busy = null;
    log(`발송 끝: ${finalState}`);
  }
}

// --- HTTP ---------------------------------------------------------------------------------------

function send(res, origin, code, body) {
  const headers = {};
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
  res.writeHead(code, headers);
  res.end(body === undefined ? "" : JSON.stringify(body));
}

class BadRequest extends Error {}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 32 * 1024 * 1024) throw new BadRequest("body too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new BadRequest("invalid JSON");
  }
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) return send(res, null, 403, { ok: false, error: "host not allowed" });
  // Requests from any other web page are refused outright, not just left without CORS headers.
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) return send(res, null, 403, { ok: false, error: "origin not allowed" });

  if (req.method === "OPTIONS") {
    if (!origin) return send(res, null, 403);
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });
    return res.end();
  }
  if (req.method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    return send(res, origin, 415, { ok: false, error: "Content-Type must be application/json" });
  }

  const { pathname } = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && pathname === "/status") {
      const status = await currentStatus();
      return send(res, origin, 200, {
        status,
        version: VERSION_LABEL,
        dry_run: DRY_RUN || undefined,
        current_sync_cnt: sync.count,
        current_sent_order: status === "SendMessage" ? job.results.length : undefined,
        last_error: status === "GetKaoFriends" ? null : sync.lastError,
      });
    }
    if (req.method === "POST" && pathname === "/friends/synchronize") {
      const { mode, option } = await readJson(req);
      if (mode === "Stop") {
        // The whole list is read in one go (a few seconds), and killing kakao-mac midway would leave
        // KakaoTalk on the friends tab; let it finish, its result is still useful.
        return send(res, origin, 202, { ok: true });
      }
      if (mode !== "Start-all" && mode !== "Start-search") return send(res, origin, 400, { ok: false, error: "unknown mode" });
      if (shuttingDown) return send(res, origin, 409, { ok: false, status: "ShuttingDown" });
      const status = await currentStatus();
      // Checked again after the await: another request may have started a job meanwhile.
      if (status !== "Ready" || busy || shuttingDown) return send(res, origin, 409, { ok: false, status: busy ?? (shuttingDown ? "ShuttingDown" : status) });
      runSync(mode === "Start-search" ? String(option ?? "").trim() : "");
      return send(res, origin, 202, { ok: true });
    }
    if (req.method === "GET" && pathname === "/friends") {
      const counts = new Map();
      sync.result.forEach((name) => counts.set(name, (counts.get(name) ?? 0) + 1));
      return send(res, origin, 200, {
        friend_list: sync.result.map((name) => ({ name })),
        duplicate_friend_list: [...counts].filter(([, n]) => n > 1).map(([name]) => name),
        kakao_friend_count: sync.kakaoFriendCount,
        unreadable_count: 0, // names come from the Accessibility API, never misread
      });
    }
    if (req.method === "POST" && pathname === "/send") {
      const body = await readJson(req);
      const recipients = Array.isArray(body.recipients) ? body.recipients : [];
      if (recipients.length === 0 || recipients.some((r) => !String(r?.name ?? "").trim())) {
        return send(res, origin, 400, { ok: false, error: "recipients required" });
      }
      // Image sending is not implemented yet. Refusing the job is safer than sending only the text.
      if (Array.isArray(body.images) && body.images.length > 0) return send(res, origin, 400, { ok: false, error: "images_not_supported" });
      if (shuttingDown) return send(res, origin, 409, { ok: false, status: "ShuttingDown" });
      const status = await currentStatus();
      // Checked again after the await: another request may have started a job meanwhile.
      if (status !== "Ready" || busy || shuttingDown) return send(res, origin, 409, { ok: false, status: busy ?? (shuttingDown ? "ShuttingDown" : status) });
      runSend({ ...body, recipients });
      return send(res, origin, 202, { ok: true });
    }
    if (req.method === "GET" && pathname === "/send/result") {
      return send(res, origin, 200, { job_id: job.job_id, state: job.state, results: job.results });
    }
    if (req.method === "POST" && pathname === "/send/stop") {
      // Finishes the recipient in progress, then stops (a running kakao-mac send is never cut off midway).
      job.stopRequested = true;
      job.wake?.();
      return send(res, origin, 202, { ok: true });
    }
    if (req.method === "POST" && pathname === "/shutdown") {
      send(res, origin, 202, { ok: true });
      shuttingDown = true;
      job.stopRequested = true;
      job.wake?.();
      // Let the KakaoTalk operation in progress (and any queued status check) finish: kakao-mac restores
      // KakaoTalk itself, and the send loop records and saves the recipient's result before it stops.
      const exitWhenIdle = () => (queued > 0 || busy ? setTimeout(exitWhenIdle, 200) : process.exit(0));
      return setTimeout(exitWhenIdle, 50);
    }
    send(res, origin, 404, { ok: false, error: "not found" });
  } catch (error) {
    send(res, origin, error instanceof BadRequest ? 400 : 500, { ok: false, error: String(error?.message ?? error) });
  }
});

server.on("error", (error) => {
  console.error(`localhost:${PORT} 를 열지 못했습니다 (${error.code}). 다른 PC 프로그램이나 mock-daemon 이 켜져 있는지 확인하세요.`);
  process.exit(1);
});
loadJob();
server.listen(PORT, "127.0.0.1", () => {
  log(`NineTalk Mac daemon on http://localhost:${PORT}${DRY_RUN ? " (dry-run)" : ""}, allowed origins: ${[...ALLOWED_ORIGINS].join(", ")}`);
});
