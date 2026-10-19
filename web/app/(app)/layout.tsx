import { connection } from "next/server";
import { Suspense } from "react";
import { DaemonStatus } from "@/components/daemon-status";
import { NavLinks } from "@/components/nav-links";
import { requireUser } from "@/lib/auth";
import { localMode } from "@/lib/local-mode";

async function UserBadge() {
  const user = await requireUser();
  return (
    <div className="flex items-center gap-2">
      {user.profileImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={user.profileImage} alt="" className="h-8 w-8 rounded-full object-cover" />
      ) : (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-kakao text-sm font-bold text-kakao-ink">
          {user.nickname.slice(0, 1)}
        </div>
      )}
      <span className="truncate text-sm font-medium">{user.nickname}</span>
    </div>
  );
}

// The desktop app has no login (local mode), so there is nothing to log out of.
async function LogoutButton() {
  await connection();
  if (localMode()) return null;
  return (
    <form action="/auth/logout" method="post">
      <button type="submit" className="text-xs text-muted hover:text-foreground">
        로그아웃
      </button>
    </form>
  );
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-border bg-surface p-4 md:sticky md:top-0 md:flex md:h-screen md:w-60 md:shrink-0 md:flex-col md:gap-6 md:border-r md:border-b-0">
        <div className="mb-3 flex items-center justify-between md:mb-0 md:block">
          <p className="text-lg font-bold">💬 단체톡 관리</p>
        </div>
        <NavLinks />
        <div className="mt-3 space-y-3 md:mt-auto">
          <DaemonStatus />
          <div className="flex items-center justify-between gap-2">
            <Suspense fallback={<div className="h-8 w-24 animate-pulse rounded bg-black/5" />}>
              <UserBadge />
            </Suspense>
            <Suspense>
              <LogoutButton />
            </Suspense>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
