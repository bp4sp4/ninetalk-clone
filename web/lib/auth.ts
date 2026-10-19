import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { db } from "./db";
import { localMode } from "./local-mode";
import { getSessionUserId } from "./session";

export type User = { id: number; nickname: string; profileImage: string | null };

type UserRow = { id: number; nickname: string; profile_image: string | null };

const LOCAL_USER_KAKAO_ID = "local:desktop";

/** Reads the session cookie and loads the user; redirects to the login page when signed out. */
export const requireUser = cache(async (): Promise<User> => {
  if (localMode()) {
    // Keep the render dynamic exactly like the cookie path does.
    await connection();
    const existing = db.prepare("SELECT id FROM users WHERE kakao_id = ?").get(LOCAL_USER_KAKAO_ID) as
      | { id: number }
      | undefined;
    const id = existing?.id ?? upsertUser(LOCAL_USER_KAKAO_ID, "사용자", null);
    return { id, nickname: "사용자", profileImage: null };
  }

  const userId = await getSessionUserId();
  if (!userId) redirect("/");

  const row = db
    .prepare("SELECT id, nickname, profile_image FROM users WHERE id = ?")
    .get(userId) as UserRow | undefined;
  if (!row) redirect("/");

  return { id: row.id, nickname: row.nickname, profileImage: row.profile_image };
});

export function upsertUser(kakaoId: string, nickname: string, profileImage: string | null): number {
  const row = db
    .prepare(
      `INSERT INTO users (kakao_id, nickname, profile_image) VALUES (?, ?, ?)
       ON CONFLICT(kakao_id) DO UPDATE SET nickname = excluded.nickname, profile_image = excluded.profile_image
       RETURNING id`,
    )
    .get(kakaoId, nickname, profileImage) as { id: number };
  return row.id;
}

export const kakaoConfigured = () => Boolean(process.env.KAKAO_REST_API_KEY);

export const devLoginEnabled = () =>
  process.env.NODE_ENV !== "production" && process.env.DEV_LOGIN === "1";
