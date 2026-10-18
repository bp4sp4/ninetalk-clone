import "server-only";
import { db } from "./db";
import { requireUser } from "./auth";

export type SenderType = "Honorific" | "TalkDown";

export type Friend = {
  id: number;
  name: string;
  senderType: SenderType;
  memo: string;
  groupIds: number[];
  duplicateCount: number;
};

export type Group = {
  id: number;
  name: string;
  isDefault: boolean;
  memberCount: number;
};

export type JobSummary = {
  id: number;
  title: string;
  status: "queued" | "sending" | "done" | "canceled";
  total: number;
  sent: number;
  failed: number;
  fileCount: number;
  createdAt: string;
  failures: { name: string; error: string | null }[];
};

type FriendRow = {
  id: number;
  name: string;
  sender_type: SenderType;
  memo: string;
  group_ids: string | null;
  dup: number;
};

// Every exported reader resolves the session itself, so callers cannot ask for another user's data.

export async function getFriends(): Promise<Friend[]> {
  const user = await requireUser();
  const rows = db
    .prepare(
      `SELECT f.id, f.name, f.sender_type, f.memo,
              (SELECT group_concat(gm.group_id) FROM group_members gm WHERE gm.friend_id = f.id) AS group_ids,
              (SELECT count(*) FROM friends d WHERE d.user_id = f.user_id AND d.name = f.name) AS dup
       FROM friends f WHERE f.user_id = ? ORDER BY f.name COLLATE NOCASE, f.id`,
    )
    .all(user.id) as FriendRow[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    senderType: row.sender_type,
    memo: row.memo,
    groupIds: row.group_ids ? row.group_ids.split(",").map(Number) : [],
    duplicateCount: row.dup,
  }));
}

export async function getGroups(): Promise<Group[]> {
  const user = await requireUser();
  const rows = db
    .prepare(
      `SELECT g.id, g.name, g.is_default,
              (SELECT count(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count
       FROM groups g WHERE g.user_id = ? ORDER BY g.sort_order, g.id`,
    )
    .all(user.id) as { id: number; name: string; is_default: number; member_count: number }[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    isDefault: row.is_default === 1,
    memberCount: row.member_count,
  }));
}

export async function getJobs(limit = 50): Promise<JobSummary[]> {
  const user = await requireUser();
  const rows = db
    .prepare(
      `SELECT j.id, j.title, j.status, j.created_at,
              (SELECT count(*) FROM send_job_recipients r WHERE r.job_id = j.id) AS total,
              (SELECT count(*) FROM send_job_recipients r WHERE r.job_id = j.id AND r.status = 'sent') AS sent,
              (SELECT count(*) FROM send_job_recipients r WHERE r.job_id = j.id AND r.status = 'failed') AS failed,
              (SELECT count(*) FROM send_job_files f WHERE f.job_id = j.id) AS file_count
       FROM send_jobs j WHERE j.user_id = ? ORDER BY j.id DESC LIMIT ?`,
    )
    .all(user.id, limit) as {
    id: number;
    title: string;
    status: JobSummary["status"];
    created_at: string;
    total: number;
    sent: number;
    failed: number;
    file_count: number;
  }[];

  const failuresOf = db.prepare(
    "SELECT name, error FROM send_job_recipients WHERE job_id = ? AND status = 'failed' ORDER BY id LIMIT 100",
  );

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    total: row.total,
    sent: row.sent,
    failed: row.failed,
    fileCount: row.file_count,
    createdAt: row.created_at,
    // node:sqlite rows have a null prototype, which React will not pass to a Client Component.
    failures:
      row.failed > 0
        ? (failuresOf.all(row.id) as { name: string; error: string | null }[]).map(({ name, error }) => ({ name, error }))
        : [],
  }));
}

export async function getStats() {
  const user = await requireUser();
  const count = (sql: string) => (db.prepare(sql).get(user.id) as { n: number }).n;
  return {
    friends: count("SELECT count(*) AS n FROM friends WHERE user_id = ?"),
    groups: count("SELECT count(*) AS n FROM groups WHERE user_id = ?"),
    queuedJobs: count("SELECT count(*) AS n FROM send_jobs WHERE user_id = ? AND status = 'queued'"),
    sentMessages: count(
      `SELECT count(*) AS n FROM send_job_recipients r JOIN send_jobs j ON j.id = r.job_id
       WHERE j.user_id = ? AND r.status = 'sent'`,
    ),
  };
}
