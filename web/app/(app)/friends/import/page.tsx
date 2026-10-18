import Link from "next/link";
import { Suspense } from "react";
import { PageHeader, PanelSkeleton } from "@/components/page-header";
import { getFriends, getGroups } from "@/lib/data";
import { KakaoImport } from "./kakao-import";

async function ImportPanel() {
  const [friends, groups] = await Promise.all([getFriends(), getGroups()]);
  return <KakaoImport existingNames={[...new Set(friends.map((friend) => friend.name))]} groups={groups} />;
}

export default function FriendImportPage() {
  return (
    <>
      <PageHeader
        title="카카오톡 친구 불러오기"
        description="PC 카카오톡의 친구 목록을 읽어 와서, 고른 친구만 한 번에 등록합니다."
      >
        <Link href="/friends" className="btn">
          ← 친구 관리
        </Link>
      </PageHeader>
      <Suspense fallback={<PanelSkeleton />}>
        <ImportPanel />
      </Suspense>
    </>
  );
}
