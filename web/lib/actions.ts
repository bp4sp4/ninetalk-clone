"use server";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { refresh } from "next/cache";
import { requireUser } from "./auth";
import { DATA_DIR, db, transaction } from "./db";
import { NAME_TOKEN, renderMessage } from "./message";
import {
  LEGACY_INTERVAL_MS,
  SPEED_PRESETS,
  customSettingError,
  isSpeedPreset,
  speedRateFor,
  type SendMode,
  type SpeedSetting,
} from "./send-speed";
import type { SenderType } from "./data";

/** `id`: the row an action created, when the caller needs it (e.g. the new send job). */
export type ActionResult = { ok: true; message?: string; id?: number } | { ok: false; error: string };

const MAX_NAME_LENGTH = 50;
const MAX_FRIENDS_PER_IMPORT = 5000;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const isSenderType = (value: unknown): value is SenderType => value === "Honorific" || value === "TalkDown";

/** Keeps only ids of rows in `table` that belong to the user. */
function ownedIds(table: "friends" | "groups", userId: number, ids: number[]): number[] {
  const unique = [...new Set(ids.filter(Number.isInteger))];
  if (unique.length === 0) return [];
  const placeholders = unique.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id FROM ${table} WHERE user_id = ? AND id IN (${placeholders})`)
    .all(userId, ...unique) as { id: number }[];
  return rows.map((row) => row.id);
}

// ---------- friends ----------

export async function addFriends(names: string[], senderType: SenderType, groupId?: number): Promise<ActionResult> {
  const user = await requireUser();
  if (!isSenderType(senderType)) return { ok: false, error: "말투 값이 올바르지 않습니다." };

  const cleaned = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (cleaned.length === 0) return { ok: false, error: "추가할 이름을 입력하세요." };
  if (cleaned.length > MAX_FRIENDS_PER_IMPORT) return { ok: false, error: `한 번에 ${MAX_FRIENDS_PER_IMPORT}명까지 추가할 수 있습니다.` };
  const tooLong = cleaned.find((name) => name.length > MAX_NAME_LENGTH);
  if (tooLong) return { ok: false, error: `이름이 너무 깁니다: ${tooLong.slice(0, 20)}…` };

  const targetGroup = groupId ? ownedIds("groups", user.id, [groupId])[0] : undefined;

  const existing = new Set(
    (db.prepare("SELECT name FROM friends WHERE user_id = ?").all(user.id) as { name: string }[]).map((row) => row.name),
  );
  const fresh = cleaned.filter((name) => !existing.has(name));

  transaction(() => {
    const insert = db.prepare("INSERT INTO friends (user_id, name, sender_type) VALUES (?, ?, ?) RETURNING id");
    const join = db.prepare("INSERT OR IGNORE INTO group_members (group_id, friend_id) VALUES (?, ?)");
    for (const name of fresh) {
      const { id } = insert.get(user.id, name, senderType) as { id: number };
      if (targetGroup) join.run(targetGroup, id);
    }
  });

  refresh();
  const skipped = cleaned.length - fresh.length;
  return { ok: true, message: `${fresh.length}명 추가${skipped ? `, 이미 있는 이름 ${skipped}명은 건너뜀` : ""}` };
}

export async function updateFriend(id: number, fields: { name?: string; senderType?: SenderType; memo?: string }): Promise<ActionResult> {
  const user = await requireUser();
  if (ownedIds("friends", user.id, [id]).length === 0) return { ok: false, error: "친구를 찾을 수 없습니다." };

  if (fields.name !== undefined) {
    const name = fields.name.trim();
    if (!name || name.length > MAX_NAME_LENGTH) return { ok: false, error: "이름은 1~50자로 입력하세요." };
    db.prepare("UPDATE friends SET name = ? WHERE id = ?").run(name, id);
  }
  if (fields.senderType !== undefined) {
    if (!isSenderType(fields.senderType)) return { ok: false, error: "말투 값이 올바르지 않습니다." };
    db.prepare("UPDATE friends SET sender_type = ? WHERE id = ?").run(fields.senderType, id);
  }
  if (fields.memo !== undefined) {
    db.prepare("UPDATE friends SET memo = ? WHERE id = ?").run(fields.memo.slice(0, 200), id);
  }
  refresh();
  return { ok: true };
}

export async function setFriendsSenderType(ids: number[], senderType: SenderType): Promise<ActionResult> {
  const user = await requireUser();
  if (!isSenderType(senderType)) return { ok: false, error: "말투 값이 올바르지 않습니다." };
  const owned = ownedIds("friends", user.id, ids);
  transaction(() => {
    const update = db.prepare("UPDATE friends SET sender_type = ? WHERE id = ?");
    for (const id of owned) update.run(senderType, id);
  });
  refresh();
  return { ok: true, message: `${owned.length}명의 말투를 변경했습니다.` };
}

export async function deleteFriends(ids: number[]): Promise<ActionResult> {
  const user = await requireUser();
  const owned = ownedIds("friends", user.id, ids);
  transaction(() => {
    const remove = db.prepare("DELETE FROM friends WHERE id = ?");
    for (const id of owned) remove.run(id);
  });
  refresh();
  return { ok: true, message: `${owned.length}명을 삭제했습니다.` };
}

// ---------- groups ----------

export async function createGroup(name: string): Promise<ActionResult> {
  const user = await requireUser();
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 30) return { ok: false, error: "그룹 이름은 1~30자로 입력하세요." };

  const { n } = db.prepare("SELECT coalesce(max(sort_order), -1) + 1 AS n FROM groups WHERE user_id = ?").get(user.id) as { n: number };
  const { c } = db.prepare("SELECT count(*) AS c FROM groups WHERE user_id = ?").get(user.id) as { c: number };
  db.prepare("INSERT INTO groups (user_id, name, sort_order, is_default) VALUES (?, ?, ?, ?)").run(user.id, trimmed, n, c === 0 ? 1 : 0);
  refresh();
  return { ok: true };
}

export async function renameGroup(id: number, name: string): Promise<ActionResult> {
  const user = await requireUser();
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 30) return { ok: false, error: "그룹 이름은 1~30자로 입력하세요." };
  if (ownedIds("groups", user.id, [id]).length === 0) return { ok: false, error: "그룹을 찾을 수 없습니다." };
  db.prepare("UPDATE groups SET name = ? WHERE id = ?").run(trimmed, id);
  refresh();
  return { ok: true };
}

export async function deleteGroup(id: number): Promise<ActionResult> {
  const user = await requireUser();
  if (ownedIds("groups", user.id, [id]).length === 0) return { ok: false, error: "그룹을 찾을 수 없습니다." };
  transaction(() => {
    const wasDefault = (db.prepare("SELECT is_default FROM groups WHERE id = ?").get(id) as { is_default: number }).is_default;
    db.prepare("DELETE FROM groups WHERE id = ?").run(id);
    if (wasDefault) {
      db.prepare(
        "UPDATE groups SET is_default = 1 WHERE id = (SELECT id FROM groups WHERE user_id = ? ORDER BY sort_order, id LIMIT 1)",
      ).run(user.id);
    }
  });
  refresh();
  return { ok: true, message: "그룹을 삭제했습니다. 친구는 남아 있습니다." };
}

export async function moveGroup(id: number, direction: "up" | "down"): Promise<ActionResult> {
  const user = await requireUser();
  const order = db.prepare("SELECT id FROM groups WHERE user_id = ? ORDER BY sort_order, id").all(user.id) as { id: number }[];
  const index = order.findIndex((row) => row.id === id);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || swapWith < 0 || swapWith >= order.length) return { ok: true };

  [order[index], order[swapWith]] = [order[swapWith], order[index]];
  transaction(() => {
    const update = db.prepare("UPDATE groups SET sort_order = ? WHERE id = ?");
    order.forEach((row, position) => update.run(position, row.id));
  });
  refresh();
  return { ok: true };
}

export async function setDefaultGroup(id: number): Promise<ActionResult> {
  const user = await requireUser();
  if (ownedIds("groups", user.id, [id]).length === 0) return { ok: false, error: "그룹을 찾을 수 없습니다." };
  transaction(() => {
    db.prepare("UPDATE groups SET is_default = 0 WHERE user_id = ?").run(user.id);
    db.prepare("UPDATE groups SET is_default = 1 WHERE id = ?").run(id);
  });
  refresh();
  return { ok: true };
}

export async function addToGroup(groupId: number, friendIds: number[]): Promise<ActionResult> {
  const user = await requireUser();
  if (ownedIds("groups", user.id, [groupId]).length === 0) return { ok: false, error: "그룹을 찾을 수 없습니다." };
  const owned = ownedIds("friends", user.id, friendIds);
  transaction(() => {
    const join = db.prepare("INSERT OR IGNORE INTO group_members (group_id, friend_id) VALUES (?, ?)");
    for (const id of owned) join.run(groupId, id);
  });
  refresh();
  return { ok: true, message: `${owned.length}명을 그룹에 넣었습니다.` };
}

export async function removeFromGroup(groupId: number, friendIds: number[]): Promise<ActionResult> {
  const user = await requireUser();
  if (ownedIds("groups", user.id, [groupId]).length === 0) return { ok: false, error: "그룹을 찾을 수 없습니다." };
  const owned = ownedIds("friends", user.id, friendIds);
  transaction(() => {
    const leave = db.prepare("DELETE FROM group_members WHERE group_id = ? AND friend_id = ?");
    for (const id of owned) leave.run(groupId, id);
  });
  refresh();
  return { ok: true, message: `${owned.length}명을 그룹에서 뺐습니다.` };
}

// ---------- send jobs ----------

const safeFileName = (name: string) => name.replace(/[^\w.\-가-힣]+/g, "_").slice(-80) || "image";

export async function createSendJob(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();

  const honorific = String(formData.get("honorific") ?? "").trim();
  const talkdown = String(formData.get("talkdown") ?? "").trim();
  // Speed: a preset is taken from the server's own table; only "custom" uses the submitted numbers.
  const preset = formData.get("speedPreset") ?? "normal";
  if (!isSpeedPreset(preset)) return { ok: false, error: "발송 속도 설정이 올바르지 않습니다." };
  const speed: SpeedSetting =
    preset === "custom"
      ? {
          intervalMs: Number(formData.get("intervalMs")),
          splitCount: Number(formData.get("splitSendCount")),
          mode: formData.get("sendMode") === "normal" ? "normal" : "restart",
        }
      : SPEED_PRESETS[preset];
  if (preset === "custom") {
    const error = customSettingError(speed);
    if (error) return { ok: false, error };
  }
  const imageFirst = formData.get("imageFirst") === "on";
  const groupIds = ownedIds("groups", user.id, formData.getAll("groupIds").map(Number));
  const friendIds = ownedIds("friends", user.id, formData.getAll("friendIds").map(Number));
  const files = formData.getAll("files").filter((file): file is File => file instanceof File && file.size > 0);

  if (!honorific && files.length === 0) return { ok: false, error: "메시지 내용이나 이미지를 넣어 주세요." };
  if (honorific.length > 2000 || talkdown.length > 2000) return { ok: false, error: "메시지는 2000자까지 입력할 수 있습니다." };
  if (files.length > MAX_FILES) return { ok: false, error: `이미지는 ${MAX_FILES}장까지 첨부할 수 있습니다.` };
  for (const file of files) {
    if (!IMAGE_TYPES.has(file.type)) return { ok: false, error: `이미지 파일만 첨부할 수 있습니다: ${file.name}` };
    if (file.size > MAX_FILE_BYTES) return { ok: false, error: `5MB 이하 이미지만 첨부할 수 있습니다: ${file.name}` };
  }

  // Recipients: members of the chosen groups plus individually chosen friends, each friend once.
  const ids = new Set(friendIds);
  if (groupIds.length > 0) {
    const placeholders = groupIds.map(() => "?").join(",");
    const members = db
      .prepare(`SELECT DISTINCT friend_id FROM group_members WHERE group_id IN (${placeholders})`)
      .all(...groupIds) as { friend_id: number }[];
    members.forEach((row) => ids.add(row.friend_id));
  }
  if (ids.size === 0) return { ok: false, error: "받는 사람을 한 명 이상 고르세요." };

  const recipientIds = [...ids];
  const placeholders = recipientIds.map(() => "?").join(",");
  const recipients = db
    .prepare(`SELECT id, name, sender_type FROM friends WHERE user_id = ? AND id IN (${placeholders}) ORDER BY name`)
    .all(user.id, ...recipientIds) as { id: number; name: string; sender_type: SenderType }[];

  const firstLine = (honorific.split(/\r?\n/)[0] || "이미지 메시지").replaceAll(NAME_TOKEN, "○○").slice(0, 40);

  const jobId = transaction(() => {
    const { id } = db
      .prepare(
        `INSERT INTO send_jobs (user_id, title, honorific_text, talkdown_text, speed_rate, split_send_count, interval_ms, send_mode, image_first)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        user.id,
        firstLine,
        honorific,
        talkdown,
        speedRateFor(speed.intervalMs),
        speed.splitCount,
        speed.intervalMs,
        speed.mode,
        imageFirst ? 1 : 0,
      ) as { id: number };

    const insert = db.prepare(
      "INSERT INTO send_job_recipients (job_id, friend_id, name, sender_type, text) VALUES (?, ?, ?, ?, ?)",
    );
    for (const recipient of recipients) {
      insert.run(id, recipient.id, recipient.name, recipient.sender_type, renderMessage(recipient.name, recipient.sender_type, honorific, talkdown));
    }
    return id;
  });

  if (files.length > 0) {
    const dir = path.join(DATA_DIR, "uploads", `job-${jobId}`);
    await mkdir(dir, { recursive: true });
    const insertFile = db.prepare("INSERT INTO send_job_files (job_id, file_name, mime, size, path) VALUES (?, ?, ?, ?, ?)");
    for (const [index, file] of files.entries()) {
      const fileName = `${index + 1}-${safeFileName(file.name)}`;
      const filePath = path.join(dir, fileName);
      await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
      insertFile.run(jobId, file.name, file.type, file.size, path.relative(DATA_DIR, filePath));
    }
  }

  refresh();
  return { ok: true, id: jobId, message: `${recipients.length}명에게 보낼 발송 요청을 만들었습니다.` };
}

// ---------- handing jobs to the PC program (contract: DAEMON_API.md "발송") ----------

export type SendPayload = {
  job_id: number;
  recipients: { id: number; name: string; text: string }[];
  images: { name: string; mime: string; data_base64: string }[];
  image_first: boolean;
  /** Old 1~5 speed, still sent for PC programs that do not read interval_ms. */
  speed_rate: number;
  /** Recipients between KakaoTalk restarts ("restart" mode); null for none. */
  split_send_count: number | null;
  /** Pause after each recipient, in milliseconds. */
  interval_ms: number;
  /** "restart": restart PC KakaoTalk every split_send_count recipients; "normal": never. */
  send_mode: SendMode;
};

const SEND_ERRORS = new Set([
  "not_found",
  "duplicate_name",
  "room_mismatch",
  "send_failed",
  "kakao_not_ready",
  "input_not_empty",
  "partial_sent",
  "unknown_result",
  "dry_run",
]);

/** Loads the not-yet-sent part of a job for the PC program and marks the job as sending. */
export async function getSendPayload(jobId: number): Promise<{ ok: true; payload: SendPayload } | { ok: false; error: string }> {
  const user = await requireUser();
  const job = db
    .prepare(
      "SELECT id, status, speed_rate, split_send_count, interval_ms, send_mode, image_first FROM send_jobs WHERE id = ? AND user_id = ?",
    )
    .get(jobId, user.id) as
    | {
        id: number;
        status: string;
        speed_rate: number;
        split_send_count: number | null;
        interval_ms: number | null;
        send_mode: string | null;
        image_first: number;
      }
    | undefined;
  if (!job) return { ok: false, error: "발송 요청을 찾을 수 없습니다." };
  if (job.status !== "queued" && job.status !== "sending") return { ok: false, error: "대기 중인 요청만 보낼 수 있습니다." };

  const recipients = db
    .prepare("SELECT id, name, text FROM send_job_recipients WHERE job_id = ? AND status = 'pending' ORDER BY id")
    .all(jobId) as SendPayload["recipients"];
  if (recipients.length === 0) return { ok: false, error: "보낼 사람이 남아 있지 않습니다." };

  const files = db.prepare("SELECT file_name, mime, path FROM send_job_files WHERE job_id = ? ORDER BY id").all(jobId) as {
    file_name: string;
    mime: string;
    path: string;
  }[];
  const images = await Promise.all(
    files.map(async (file) => ({
      name: file.file_name,
      mime: file.mime,
      data_base64: (await readFile(path.join(DATA_DIR, file.path))).toString("base64"),
    })),
  );

  db.prepare("UPDATE send_jobs SET status = 'sending' WHERE id = ?").run(jobId);
  refresh();
  return {
    ok: true,
    payload: {
      job_id: jobId,
      recipients: recipients.map((row) => ({ id: row.id, name: row.name, text: row.text })),
      images,
      image_first: job.image_first === 1,
      speed_rate: job.speed_rate,
      split_send_count: job.split_send_count,
      // Jobs saved before interval_ms existed: interval from the old 1~5 speed, and no restarts.
      interval_ms: job.interval_ms ?? LEGACY_INTERVAL_MS[job.speed_rate] ?? 800,
      send_mode: job.send_mode === "restart" ? "restart" : "normal",
    },
  };
}

/**
 * Stores per-recipient results reported by the PC program. When the run is over, the job is
 * done if nobody is left, otherwise it goes back to the queue so the rest can be sent later.
 */
export async function recordSendResults(
  jobId: number,
  results: { id: number; status: "sent" | "failed"; error?: string }[],
  finished: boolean,
): Promise<ActionResult> {
  const user = await requireUser();
  const job = db.prepare("SELECT id FROM send_jobs WHERE id = ? AND user_id = ?").get(jobId, user.id);
  if (!job) return { ok: false, error: "발송 요청을 찾을 수 없습니다." };

  transaction(() => {
    const update = db.prepare("UPDATE send_job_recipients SET status = ?, error = ? WHERE id = ? AND job_id = ?");
    for (const result of results.slice(0, 5000)) {
      if (!Number.isInteger(result.id) || (result.status !== "sent" && result.status !== "failed")) continue;
      const error = result.status === "failed" ? (SEND_ERRORS.has(result.error ?? "") ? result.error! : "send_failed") : null;
      update.run(result.status, error, result.id, jobId);
    }
    if (finished) {
      const { pending } = db
        .prepare("SELECT count(*) AS pending FROM send_job_recipients WHERE job_id = ? AND status = 'pending'")
        .get(jobId) as { pending: number };
      db.prepare("UPDATE send_jobs SET status = ? WHERE id = ? AND status != 'canceled'").run(pending === 0 ? "done" : "queued", jobId);
    }
  });
  refresh();
  return { ok: true };
}

export async function cancelJob(id: number): Promise<ActionResult> {
  const user = await requireUser();
  const result = db
    .prepare("UPDATE send_jobs SET status = 'canceled' WHERE id = ? AND user_id = ? AND status = 'queued'")
    .run(id, user.id);
  refresh();
  return result.changes ? { ok: true, message: "발송 요청을 취소했습니다." } : { ok: false, error: "대기 중인 요청만 취소할 수 있습니다." };
}
