// NineTalk PC program for Mac: the same local HTTP API as the Windows daemon (../DAEMON_API.md) on
// http://localhost:47301, driving KakaoTalk for Mac through ./build/kakao-mac (Accessibility API).
//
//   node server.mjs                       real sending
//   NINETALK_MAC_DRY_RUN=1 node server.mjs  every send is a dry run (opens the chat, types, clears, closes)
//
// Env: NINETALK_ALLOWED_ORIGINS (comma list), KAKAO_MAC_BIN (path to the kakao-mac binary),
// NINETALK_MAC_STATE_DIR (where the last send job is kept), NINETALK_MAC_PORT (tests).
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// NINETALK_MAC_PORT is only for testing next to another daemon; the dashboard always calls 47301.
const PORT = Number(process.env.NINETALK_MAC_PORT) || 47301;
const VERSION = "0.1.11-mac";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.KAKAO_MAC_BIN || path.join(HERE, "build", "kakao-mac");
const DRY_RUN = process.env.NINETALK_MAC_DRY_RUN === "1";
// Shown in the dashboard sidebar, so a forgotten dry-run setting is visible.
const VERSION_LABEL = DRY_RUN ? `${VERSION} (dry-run: 실제로 안 보냄)` : VERSION;
// This many failures in a row with the same cause mean something is wrong with KakaoTalk itself: stop the job.
const MAX_SAME_FAILURES = 3;
// Images per job and their size, like the dashboard's own limits (5 images, 5MB each) with some room.
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic" };
// Files (PDF, 한글, 엑셀, zip ...): images and files together at most 5, each file up to 20MB (DAEMON_API.md).
const MAX_ATTACHMENTS = 5;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Programs and scripts are never sent (the dashboard and the Windows daemon refuse them too).
const BLOCKED_EXT = new Set([".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".ps1", ".vbs", ".js", ".jse", ".wsf", ".dll", ".lnk", ".app", ".pkg", ".dmg", ".sh", ".command"]); // = web/lib/attachments.ts
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

// Pause after each recipient: interval_ms (200~2000), or for older dashboards the 1~5 speed_rate.
// "restart" mode (restart KakaoTalk every split_send_count) is Windows-only for now; here it just keeps going.
const LEGACY_INTERVAL_MS = [800, 2000, 1200, 800, 400, 200];
const intervalFor = (interval_ms, speed_rate) =>
  Math.min(2000, Math.max(200, Number(interval_ms) || LEGACY_INTERVAL_MS[Math.min(5, Math.max(1, Number(speed_rate) || 3))]));

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

let runningChild = null; // the kakao-mac process in flight (one at a time, see kakao() below)

function runKakao(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = execFile(BIN, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (runningChild === child) runningChild = null;
      if (stderr && process.env.KAKAO_MAC_DEBUG === "1") process.stderr.write(stderr);
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
    runningChild = child;
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
// The recipient kakao-mac is working on (no result recorded yet) and the job's image / file folders, so an
// immediate exit can still record that person and remove them.
let inFlight = null; // { id } | null
let jobImageDir = null;
let jobFileDir = null;

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

/** Checks the first bytes, so broken data is refused up front instead of failing once per recipient. */
function looksLikeImage(data, ext) {
  const head = data.subarray(0, 12);
  switch (ext) {
    case "png": return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "jpg": return head[0] === 0xff && head[1] === 0xd8;
    case "gif": return head.subarray(0, 3).toString("latin1") === "GIF";
    case "webp": return head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP";
    case "heic": return head.subarray(4, 8).toString("latin1") === "ftyp";
    default: return false;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Image and file folders left by a run that was killed (they can hold customer images and files). */
function removeLeftoverImages() {
  try {
    for (const name of readdirSync(STATE_DIR)) {
      if (!name.startsWith("images-") && !name.startsWith("files-")) continue;
      // Not while the program that wrote it still runs (a second server.mjs started by hand).
      if (processAlive(Number(name.split("-")[1]))) continue;
      rmSync(path.join(STATE_DIR, name), { recursive: true, force: true });
    }
  } catch {
    // no state folder yet
  }
}

/**
 * Writes the job's images to a temporary folder for kakao-mac (it pastes each one into the chat).
 * Throws BadRequest for anything that is not a small image.
 */
function writeImages(images) {
  if (!Array.isArray(images) || images.length === 0) return { dir: null, paths: [] };
  if (images.length > MAX_IMAGES) throw new BadRequest(`at most ${MAX_IMAGES} images`);
  const decoded = images.map((image, i) => {
    const ext = IMAGE_EXT[String(image?.mime ?? "").toLowerCase()];
    if (!ext) throw new BadRequest("unsupported image type");
    const data = Buffer.from(String(image?.data_base64 ?? ""), "base64");
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new BadRequest("image too large or empty");
    if (!looksLikeImage(data, ext)) throw new BadRequest("not a valid image");
    return { name: `${i + 1}.${ext}`, data };
  });
  const dir = path.join(STATE_DIR, `images-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const paths = decoded.map(({ name, data }) => {
    const file = path.join(dir, name);
    writeFileSync(file, data);
    return file;
  });
  return { dir, paths };
}

/**
 * The name the recipient sees, kept as a plain file name: no folders, no characters macOS or KakaoTalk trips on,
 * no program types. Null when nothing usable is left.
 */
function safeFileName(raw) {
  let name = String(raw ?? "").normalize("NFC").split(/[\\/]/).pop();
  name = name.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, "_").trim().replace(/^\.+/, "").replace(/[. ]+$/, "");
  // macOS allows 255 bytes per name, and a Korean letter is 3: keep well under it.
  if (!name || Buffer.byteLength(name, "utf8") > 200) return null;
  if (BLOCKED_EXT.has(path.extname(name).toLowerCase())) return null;
  return name;
}

/**
 * Writes the job's files for kakao-mac (it pastes each one into the chat), each in a folder of its own so the
 * recipient sees the original name. Throws BadRequest for a bad name or size.
 */
function writeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return { dir: null, paths: [] };
  if (files.length > MAX_ATTACHMENTS) throw new BadRequest(`at most ${MAX_ATTACHMENTS} attachments`);
  const decoded = files.map((file) => {
    const name = safeFileName(file?.name);
    if (!name) throw new BadRequest("file name not allowed");
    const data = Buffer.from(String(file?.data_base64 ?? ""), "base64");
    if (data.length === 0 || data.length > MAX_FILE_BYTES) throw new BadRequest("file too large or empty");
    return { name, data };
  });
  const dir = path.join(STATE_DIR, `files-${process.pid}-${Date.now()}`);
  try {
    const paths = decoded.map(({ name, data }, i) => {
      const folder = path.join(dir, String(i + 1));
      mkdirSync(folder, { recursive: true });
      const file = path.join(folder, name);
      writeFileSync(file, data);
      return file;
    });
    return { dir, paths };
  } catch (error) {
    // Disk full and the like: remove what was written (customers' files), and keep the path (a file name) out
    // of the answer and the log.
    rmSync(dir, { recursive: true, force: true });
    log("could not write the job's files:", error.code ?? "error");
    throw new Error("could not write files");
  }
}

async function runSend({ job_id, recipients, speed_rate, interval_ms, send_mode, imageFiles, attachedFiles, image_first }) {
  busy = "SendMessage";
  job = { job_id: job_id ?? null, state: "running", results: [], stopRequested: false, wake: null };
  saveJob();
  const imagePaths = imageFiles?.paths ?? [];
  const filePaths = attachedFiles?.paths ?? [];
  jobImageDir = imageFiles?.dir ?? null;
  jobFileDir = attachedFiles?.dir ?? null;
  // Above kakao-mac's own worst case (open the chat ~20 s, each image up to ~65 s with a 45 s upload wait, each
  // file up to ~110 s with a 90 s upload wait, closing up to ~40 s), so a slow upload is not cut off and then
  // wrongly recorded.
  const perRecipientTimeout = 120000 + imagePaths.length * 75000 + filePaths.length * 120000;
  const intervalMs = intervalFor(interval_ms, speed_rate);
  const attached = [imagePaths.length ? `이미지 ${imagePaths.length}장` : "", filePaths.length ? `파일 ${filePaths.length}개` : ""].filter(Boolean).join(", ");
  log(`발송 시작: ${recipients.length}명, ${intervalMs}ms 간격${attached ? `, ${attached}${image_first ? " 먼저" : ""}` : ""}${DRY_RUN ? " (dry-run, 실제로 보내지 않음)" : ""}`);
  if (send_mode === "restart") log("맥에서는 카카오톡 재시작을 아직 하지 않습니다. 재시작 없이 계속 보냅니다.");
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
      for (const file of imagePaths) args.push("--image", file);
      for (const file of filePaths) args.push("--file", file);
      if ((imagePaths.length || filePaths.length) && image_first) args.push("--image-first");
      if (!DRY_RUN) args.push("--send");
      let out;
      inFlight = { id: recipient.id };
      try {
        out = await kakao(args, perRecipientTimeout);
      } catch (error) {
        // kakao-mac was cut off or crashed: the text or an image may already have gone out, so this is not a
        // plain failure that could be sent again; the dashboard says to check the chat.
        // (A missing kakao-mac never ran, so that one is a plain failure.)
        out = { result: "failed", error: error.detail === "binary_not_found" ? "send_failed" : "unknown_result", detail: error.detail ?? "error" };
      }
      const ok = out.result === "sent";
      // dry_run: nothing went out, so it must not be recorded as sent. input_not_empty: someone's unsent draft.
      const error = out.result === "dry_run_ok" ? "dry_run" : out.detail === "input_not_empty" ? "input_not_empty" : out.error;
      job.results.push(ok ? { id: recipient.id, status: "sent" } : { id: recipient.id, status: "failed", error });
      inFlight = null;
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
      await pause(intervalMs / 1000);
    }
    if (job.stopRequested && finalState === "done" && job.results.length < recipients.length) finalState = "stopped";
  } finally {
    inFlight = null;
    job.state = finalState;
    job.wake = null;
    saveJob();
    if (imageFiles?.dir) rmSync(imageFiles.dir, { recursive: true, force: true });
    if (attachedFiles?.dir) rmSync(attachedFiles.dir, { recursive: true, force: true });
    jobImageDir = null;
    jobFileDir = null;
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
  // 5 images of 5 MB are ~35 MB as base64. Chunks are joined as bytes and decoded once, so a Korean character
  // split across two chunks is not garbled.
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024 * 1024) throw new BadRequest("body too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
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
        images: true, // this PC program can send images
        files: true, // and other files (PDF, 한글, 엑셀 ...)
        // Separate from status (which stays "SendMessage" while a last recipient finishes), so a newly started
        // desktop app can wait for this process to exit instead of adopting it.
        shutting_down: shuttingDown || undefined,
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
      const imageCount = Array.isArray(body.images) ? body.images.length : 0;
      const fileCount = Array.isArray(body.files) ? body.files.length : 0;
      if (imageCount + fileCount > MAX_ATTACHMENTS) return send(res, origin, 400, { ok: false, error: `at most ${MAX_ATTACHMENTS} attachments` });
      if (recipients.some((r) => !String(r?.text ?? "").trim()) && imageCount + fileCount === 0) {
        return send(res, origin, 400, { ok: false, error: "text or images required" });
      }
      if (shuttingDown) return send(res, origin, 409, { ok: false, status: "ShuttingDown" });
      const status = await currentStatus();
      // Checked again after the await: another request may have started a job meanwhile.
      if (status !== "Ready" || busy || shuttingDown) return send(res, origin, 409, { ok: false, status: busy ?? (shuttingDown ? "ShuttingDown" : status) });
      const imageFiles = writeImages(body.images); // throws BadRequest (400) for anything that is not a small image
      let attachedFiles;
      try {
        attachedFiles = writeFiles(body.files); // throws BadRequest (400) for a bad name or size
      } catch (error) {
        if (imageFiles.dir) rmSync(imageFiles.dir, { recursive: true, force: true });
        throw error;
      }
      runSend({ ...body, recipients, imageFiles, attachedFiles });
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
      return gracefulShutdown("shutdown request");
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
/**
 * Stops after the KakaoTalk operation in progress (and any queued status check): kakao-mac restores
 * KakaoTalk itself, and the send loop records and saves the recipient's result before it stops.
 */
function gracefulShutdown(reason) {
  if (shuttingDown) return;
  log(`종료: ${reason}`);
  shuttingDown = true;
  job.stopRequested = true;
  job.wake?.();
  const exitWhenIdle = () => (queued > 0 || busy ? setTimeout(exitWhenIdle, 200) : process.exit(0));
  setTimeout(exitWhenIdle, 50);
}

// Started by the desktop app (NINETALK_PARENT_PID): if the app dies without asking us to stop (crash, force
// quit) we would keep port 47301 for an old version, so exit like /shutdown. Not when run by hand.
const parentPid = Number(process.env.NINETALK_PARENT_PID) || 0;
if (parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      gracefulShutdown("앱이 종료됨");
    }
  }, 2000).unref();
}
/**
 * Exits now, without waiting for kakao-mac. The person it was working on may or may not have received the
 * message, so they are saved as unknown_result (the dashboard says to check the chat and does not send again),
 * and kakao-mac is told to stop too (it cancels an open image sheet and restores the clipboard on SIGTERM)
 * instead of being left running on its own.
 */
function exitNow(reason) {
  log(`바로 종료: ${reason}`);
  if (inFlight && job.state === "running") {
    job.results.push({ id: inFlight.id, status: "failed", error: "unknown_result" });
    inFlight = null;
  }
  if (job.state === "running") job.state = "stopped";
  saveJob();
  try {
    runningChild?.kill("SIGTERM");
  } catch {
    // already gone
  }
  if (jobImageDir) rmSync(jobImageDir, { recursive: true, force: true });
  if (jobFileDir) rmSync(jobFileDir, { recursive: true, force: true });
  process.exit(1);
}

// First SIGTERM: stop like /shutdown. A second one (the app's kill after /shutdown, or a stuck run): exit now.
process.on("SIGTERM", () => (shuttingDown ? exitNow("SIGTERM") : gracefulShutdown("SIGTERM")));
// Our parent's end of the log pipe may be gone; a failed log write must not kill a send in progress.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

removeLeftoverImages();
loadJob();
server.listen(PORT, "127.0.0.1", () => {
  log(`NineTalk Mac daemon on http://localhost:${PORT}${DRY_RUN ? " (dry-run)" : ""}, allowed origins: ${[...ALLOWED_ORIGINS].join(", ")}`);
});
