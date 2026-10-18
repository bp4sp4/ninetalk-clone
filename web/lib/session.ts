import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { connection } from "next/server";

const COOKIE_NAME = "nt_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

type SessionPayload = { uid: number; exp: number };

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) {
    throw new Error("SESSION_SECRET 환경변수를 16자 이상으로 설정하세요 (.env.local)");
  }
  return value;
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

function encode(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (typeof payload.uid !== "number" || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function getSessionUserId(): Promise<number | null> {
  const store = await cookies();
  // The expiry check reads the clock, so it must run at request time, never during prerendering.
  await connection();
  return decode(store.get(COOKIE_NAME)?.value)?.uid ?? null;
}

export async function setSession(userId: number): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, encode({ uid: userId, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
