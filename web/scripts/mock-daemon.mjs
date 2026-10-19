// Fake PC program for testing the web dashboard without KakaoTalk.
// Implements the contract in ../../DAEMON_API.md.  Usage: npm run mock-daemon
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_DAEMON_PORT ?? 47301);
// localhost:3000 = npm run dev, 127.0.0.1:47300 = the desktop app (../desktop).
const ALLOWED_ORIGINS = new Set(
  (process.env.MOCK_DAEMON_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:47300").split(","),
);

const SURNAMES = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임"];
const GIVEN = ["민준", "서연", "도윤", "지우", "하준", "서윤", "은우", "지민", "예준", "수아", "시우", "하은"];
const NAMES = [
  ...SURNAMES.flatMap((surname, i) => GIVEN.slice(i % 4, (i % 4) + 4).map((given) => surname + given)),
  "김민준", // a second friend with the same display name
  "홍길동",
  "꽃집 사장님",
];
// Rows as the real daemon's OCR sees them: some names are flagged ocr_uncertain (including typical
// misreads of 김), and some rows are found but unreadable, so they only show up in unreadable_count.
const ROWS = [
  ...NAMES.map((name, i) => ({ name, uncertain: i % 9 === 4 })),
  { name: "7`도윤", uncertain: true },
  { name: "기하은", uncertain: true },
  { name: "NguyBn Van An", uncertain: true },
  { name: null },
  { name: null },
  { name: null },
];
// MOCK_DAEMON_FAIL_AT=20 makes a sync end with last_error after 20 rows, like a real OCR failure.
const FAIL_AT = Number(process.env.MOCK_DAEMON_FAIL_AT ?? 0);

let state = { status: "Ready", syncCount: 0, rowIndex: 0, timer: null, result: [], summary: null, lastError: null };

function finishSync(extra = {}) {
  clearInterval(state.timer);
  state = { ...state, status: "Ready", timer: null, ...extra };
}

// Sending (DAEMON_API.md "발송"): one recipient per tick. Like the real daemon, a job with images is
// refused (images are not supported yet). Every 7th recipient fails as not_found, to exercise failures.
let sendJob = { job_id: null, state: "done", results: [], timer: null, stopRequested: false };

function startSendJob({ job_id, recipients }) {
  sendJob = { job_id, state: "running", results: [], timer: null, stopRequested: false };
  state.status = "SendMessage";
  let index = 0;
  sendJob.timer = setInterval(() => {
    const recipient = recipients[index++];
    sendJob.results.push(
      index % 7 === 0 ? { id: recipient.id, status: "failed", error: "not_found" } : { id: recipient.id, status: "sent" },
    );
    const finished = index >= recipients.length;
    if (finished || sendJob.stopRequested) {
      clearInterval(sendJob.timer);
      sendJob.state = finished ? "done" : "stopped";
      state.status = "Ready";
    }
  }, 600);
}

function startSync(keyword) {
  state = { status: "GetKaoFriends", syncCount: 0, rowIndex: 0, timer: null, result: [], summary: null, lastError: null };
  state.timer = setInterval(() => {
    // Reads a few rows per tick, like scrolling the friend list. Start-search filters what was read, as the real daemon does.
    const next = ROWS.slice(state.rowIndex, state.rowIndex + 4);
    state.rowIndex += next.length;
    state.result.push(...next.filter((row) => row.name && (!keyword || row.name.includes(keyword))));
    state.syncCount = state.result.length;
    if (FAIL_AT > 0 && state.rowIndex >= FAIL_AT) {
      finishSync({ lastError: "친구 목록 스크롤이 멈췄습니다 (mock)" });
    } else if (state.rowIndex >= ROWS.length) {
      finishSync({ summary: { expected: ROWS.length, unreadable: ROWS.filter((row) => !row.name).length } });
    }
  }, 250);
}

function send(res, origin, code, body) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  res.writeHead(code, headers);
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

createServer(async (req, res) => {
  const origin = req.headers.origin;
  const { pathname } = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    if (!origin || !ALLOWED_ORIGINS.has(origin)) return send(res, undefined, 403);
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

  try {
    if (req.method === "GET" && pathname === "/status") {
      return send(res, origin, 200, {
        status: state.status,
        version: "0.0.0-mock",
        current_sync_cnt: state.syncCount,
        current_sent_order: state.status === "SendMessage" ? sendJob.results.length : undefined,
        last_error: state.status === "GetKaoFriends" ? null : state.lastError,
      });
    }
    if (req.method === "POST" && pathname === "/send") {
      const body = await readJson(req);
      if (!Array.isArray(body.recipients) || body.recipients.length === 0) return send(res, origin, 400, { ok: false, error: "recipients required" });
      if (Array.isArray(body.images) && body.images.length > 0) return send(res, origin, 400, { ok: false, error: "images_not_supported" });
      if (state.status !== "Ready") return send(res, origin, 409, { ok: false, status: state.status });
      startSendJob(body);
      return send(res, origin, 202, { ok: true });
    }
    if (req.method === "GET" && pathname === "/send/result") {
      return send(res, origin, 200, { job_id: sendJob.job_id, state: sendJob.state, results: sendJob.results });
    }
    if (req.method === "POST" && pathname === "/send/stop") {
      sendJob.stopRequested = true;
      return send(res, origin, 202, { ok: true });
    }
    if (req.method === "POST" && pathname === "/shutdown") {
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, origin, 415, { ok: false });
      // The desktop app's normal exit path (the real daemon removes its tray icon and restores KakaoTalk).
      send(res, origin, 202, { ok: true });
      return setTimeout(() => process.exit(0), 50);
    }
    if (req.method === "POST" && pathname === "/friends/synchronize") {
      const { mode, option } = await readJson(req);
      if (mode === "Stop") {
        finishSync();
        return send(res, origin, 202, { ok: true });
      }
      if (mode !== "Start-all" && mode !== "Start-search") return send(res, origin, 400, { ok: false, error: "unknown mode" });
      // (also refuses while a send job runs: status is SendMessage then)
      if (state.status !== "Ready") return send(res, origin, 409, { ok: false, status: state.status });
      startSync(mode === "Start-search" ? String(option ?? "").trim() : "");
      return send(res, origin, 202, { ok: true });
    }
    if (req.method === "GET" && pathname === "/friends") {
      const counts = new Map();
      state.result.forEach(({ name }) => counts.set(name, (counts.get(name) ?? 0) + 1));
      return send(res, origin, 200, {
        friend_list: state.result.map(({ name, uncertain }) => ({ name, ocr_uncertain: uncertain })),
        duplicate_friend_list: [...counts].filter(([, n]) => n > 1).map(([name]) => name),
        // Optional fields; null / 0 when the read was stopped or failed before the end, like the real daemon.
        kakao_friend_count: state.summary?.expected ?? null,
        unreadable_count: state.summary?.unreadable ?? 0,
      });
    }
    send(res, origin, 404, { ok: false, error: "not found" });
  } catch (error) {
    send(res, origin, 500, { ok: false, error: String(error) });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`mock daemon on http://localhost:${PORT} (allowed origins: ${[...ALLOWED_ORIGINS].join(", ")})`);
});
