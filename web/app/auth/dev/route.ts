import { NextResponse } from "next/server";
import { devLoginEnabled, upsertUser } from "@/lib/auth";
import { setSession } from "@/lib/session";

// Local-only shortcut for trying the dashboard before Kakao app keys are set up.
export async function POST(request: Request) {
  if (!devLoginEnabled()) return new NextResponse("Not found", { status: 404 });

  const userId = upsertUser("dev:local", "테스트 사용자", null);
  await setSession(userId);
  return NextResponse.redirect(new URL("/dashboard", request.url), 303);
}
