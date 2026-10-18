import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { requireUser } from "@/lib/auth";
import { getStats } from "@/lib/data";

async function Greeting() {
  const user = await requireUser();
  return <>{user.nickname}님, 안녕하세요</>;
}

async function Stats() {
  const stats = await getStats();
  const cards = [
    { label: "등록한 친구", value: stats.friends, href: "/friends" },
    { label: "그룹", value: stats.groups, href: "/groups" },
    { label: "대기 중인 발송", value: stats.queuedJobs, href: "/jobs" },
    { label: "보낸 메시지", value: stats.sentMessages, href: "/jobs" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((card) => (
        <Link key={card.label} href={card.href} className="card p-4 transition hover:border-foreground/30">
          <p className="text-xs text-muted">{card.label}</p>
          <p className="mt-1 text-2xl font-bold">{card.value.toLocaleString("ko-KR")}</p>
        </Link>
      ))}
    </div>
  );
}

const STEPS = [
  { title: "친구 등록", body: "카카오톡에 보이는 이름 그대로 친구를 등록하고 존댓말/반말을 정해요.", href: "/friends" },
  { title: "그룹 만들기", body: "보낼 대상을 그룹으로 묶어 두면 매번 고를 필요가 없어요.", href: "/groups" },
  { title: "메시지 작성", body: "{이름}을 넣어 한 명 한 명에게 보내는 것 같은 메시지를 만들어요.", href: "/compose" },
];

export default function DashboardPage() {
  return (
    <>
      <PageHeader title="홈">
        <Link href="/compose" className="btn btn-kakao">
          ✏️ 새 메시지 작성
        </Link>
      </PageHeader>

      <p className="-mt-4 mb-6 text-sm text-muted">
        <Suspense fallback="안녕하세요">
          <Greeting />
        </Suspense>
      </p>

      <Suspense fallback={<div className="h-24 animate-pulse rounded-xl bg-black/5" />}>
        <Stats />
      </Suspense>

      <section className="mt-8">
        <h2 className="mb-3 font-bold">시작하기</h2>
        <ol className="grid gap-3 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <Link href={step.href} className="card block h-full p-4 transition hover:border-foreground/30">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-kakao text-xs font-bold text-kakao-ink">{index + 1}</span>
                <p className="mt-2 font-medium">{step.title}</p>
                <p className="mt-1 text-sm text-muted">{step.body}</p>
              </Link>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
