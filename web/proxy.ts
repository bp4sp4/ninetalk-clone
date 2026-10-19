import { NextResponse, type NextRequest } from "next/server";
import { localMode } from "@/lib/local-mode";

// Desktop app (local mode): there is no login, so the login page and the Kakao/dev/logout routes
// all lead straight to the dashboard.
export function proxy(request: NextRequest) {
  if (!localMode()) return NextResponse.next();
  return NextResponse.redirect(new URL("/dashboard", request.url), 303);
}

export const config = {
  matcher: ["/", "/auth/:path*"],
};
