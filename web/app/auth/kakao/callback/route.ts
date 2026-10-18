import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { upsertUser } from "@/lib/auth";
import { setSession } from "@/lib/session";

type TokenResponse = { access_token?: string; error?: string; error_description?: string };

type KakaoUser = {
  id: number;
  properties?: { nickname?: string; profile_image?: string };
  kakao_account?: { profile?: { nickname?: string; profile_image_url?: string } };
};

function fail(request: Request, reason: string) {
  return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(reason)}`, request.url));
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");

  const store = await cookies();
  const expectedState = store.get("nt_oauth_state")?.value;
  store.delete({ name: "nt_oauth_state", path: "/auth/kakao" });

  if (params.get("error")) return fail(request, "kakao_denied");
  if (!code || !state || state !== expectedState) return fail(request, "invalid_state");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: process.env.KAKAO_REST_API_KEY ?? "",
    redirect_uri: process.env.KAKAO_REDIRECT_URI ?? "",
    code,
  });
  if (process.env.KAKAO_CLIENT_SECRET) body.set("client_secret", process.env.KAKAO_CLIENT_SECRET);

  const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
  });
  const token = (await tokenRes.json()) as TokenResponse;
  if (!tokenRes.ok || !token.access_token) {
    console.error("Kakao token exchange failed", token.error, token.error_description);
    return fail(request, "token_failed");
  }

  const meRes = await fetch("https://kapi.kakao.com/v2/user/me", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!meRes.ok) return fail(request, "profile_failed");
  const me = (await meRes.json()) as KakaoUser;

  const profile = me.kakao_account?.profile;
  const nickname = profile?.nickname ?? me.properties?.nickname ?? "카카오 사용자";
  const image = profile?.profile_image_url ?? me.properties?.profile_image ?? null;

  const userId = upsertUser(`kakao:${me.id}`, nickname, image);
  await setSession(userId);
  return NextResponse.redirect(new URL("/dashboard", request.url));
}
