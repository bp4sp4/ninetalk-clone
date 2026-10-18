import Link from "next/link";
import { Suspense } from "react";
import { PageHeader, PanelSkeleton } from "@/components/page-header";
import { getFriends, getGroups } from "@/lib/data";
import { FriendsManager } from "./friends-manager";

async function FriendsPanel() {
  const [friends, groups] = await Promise.all([getFriends(), getGroups()]);
  return <FriendsManager friends={friends} groups={groups} />;
}

export default function FriendsPage() {
  return (
    <>
      <PageHeader
        title="친구 관리"
        description="카카오톡에 표시되는 이름 그대로 등록하세요. 말투(존댓말/반말)에 따라 다른 문구가 나갑니다."
      >
        <Link href="/friends/import" className="btn btn-kakao">
          카카오톡에서 불러오기
        </Link>
      </PageHeader>
      <Suspense fallback={<PanelSkeleton />}>
        <FriendsPanel />
      </Suspense>
    </>
  );
}
