"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "홈", icon: "🏠" },
  { href: "/friends", label: "친구 관리", icon: "👥" },
  { href: "/groups", label: "그룹 관리", icon: "🗂️" },
  { href: "/compose", label: "메시지 작성", icon: "✏️" },
  { href: "/jobs", label: "발송 내역", icon: "📨" },
] as const;

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto md:flex-col">
      {LINKS.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
              active ? "bg-foreground text-white" : "text-foreground/80 hover:bg-black/[0.04]"
            }`}
          >
            <span aria-hidden>{link.icon}</span>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
