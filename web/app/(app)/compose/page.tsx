import { Suspense } from "react";
import { PageHeader, PanelSkeleton } from "@/components/page-header";
import { getFriends, getGroups } from "@/lib/data";
import { Composer } from "./composer";

async function ComposerPanel() {
  const [groups, friends] = await Promise.all([getGroups(), getFriends()]);
  return <Composer groups={groups} friends={friends} />;
}

export default function ComposePage() {
  return (
    <>
      <PageHeader title="메시지 작성" description="받는 사람을 고르고 문구를 쓰면, 사람마다 이름과 말투가 바뀐 메시지가 준비됩니다." />
      <Suspense fallback={<PanelSkeleton />}>
        <ComposerPanel />
      </Suspense>
    </>
  );
}
