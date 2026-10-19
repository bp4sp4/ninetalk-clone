import "server-only";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

// The desktop app points this at its user-data folder; the web dev server keeps using ./data.
export const DATA_DIR = process.env.NINETALK_DATA_DIR || path.join(process.cwd(), "data");

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  kakao_id      TEXT NOT NULL UNIQUE,
  nickname      TEXT NOT NULL,
  profile_image TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS friends (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sender_type TEXT NOT NULL DEFAULT 'Honorific' CHECK (sender_type IN ('Honorific', 'TalkDown')),
  memo        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS friends_user ON friends(user_id, name);

CREATE TABLE IF NOT EXISTS groups (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, friend_id)
);

CREATE TABLE IF NOT EXISTS send_jobs (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  honorific_text   TEXT NOT NULL,
  talkdown_text    TEXT NOT NULL,
  speed_rate       INTEGER NOT NULL,
  split_send_count INTEGER,
  image_first      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'done', 'canceled')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS send_job_recipients (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES send_jobs(id) ON DELETE CASCADE,
  friend_id   INTEGER REFERENCES friends(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error       TEXT
);

CREATE TABLE IF NOT EXISTS send_job_files (
  id        INTEGER PRIMARY KEY,
  job_id    INTEGER NOT NULL REFERENCES send_jobs(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime      TEXT NOT NULL,
  size      INTEGER NOT NULL,
  path      TEXT NOT NULL
);
`;

const SCHEMA_VERSION = 2;

const globalForDb = globalThis as unknown as { ninetalkDb?: DatabaseSync; ninetalkSchema?: number };

/** Columns added after the first release; CREATE TABLE IF NOT EXISTS does not add them to old files. */
function migrate(conn: DatabaseSync) {
  const columns = conn.prepare("PRAGMA table_info(send_job_recipients)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "error")) {
    conn.exec("ALTER TABLE send_job_recipients ADD COLUMN error TEXT");
  }
}

function connection(): DatabaseSync {
  if (!globalForDb.ninetalkDb) {
    mkdirSync(DATA_DIR, { recursive: true });
    // Build workers may open the file at the same time; wait for the lock instead of failing.
    globalForDb.ninetalkDb = new DatabaseSync(path.join(DATA_DIR, "ninetalk.db"), { timeout: 5000 });
  }
  // A connection kept across dev hot reloads may predate the current schema.
  if (globalForDb.ninetalkSchema !== SCHEMA_VERSION) {
    globalForDb.ninetalkDb.exec(SCHEMA);
    migrate(globalForDb.ninetalkDb);
    globalForDb.ninetalkSchema = SCHEMA_VERSION;
  }
  return globalForDb.ninetalkDb;
}

// Opened on first use (not at import), and reused across dev hot reloads.
export const db = new Proxy({} as DatabaseSync, {
  get(_target, prop) {
    const conn = connection();
    const value = Reflect.get(conn, prop);
    return typeof value === "function" ? value.bind(conn) : value;
  },
});

export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
