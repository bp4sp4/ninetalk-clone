import { Suspense } from "react";
import { PageHeader, PanelSkeleton } from "@/components/page-header";
import { getFriends, getGroups } from "@/lib/data";
import { GroupsManager } from "./groups-manager";

async function GroupsPanel() {
  const [groups, friends] = await Promise.all([getGroups(), getFriends()]);
  return <GroupsManager groups={groups} friends={friends} />;
}

export default function GroupsPage() {
  return (
    <>
      <PageHeader title="그룹 관리" description="고객·동호회·지역처럼 보낼 대상을 묶어 두세요. 한 친구가 여러 그룹에 들어갈 수 있습니다." />
      <Suspense fallback={<PanelSkeleton />}>
        <GroupsPanel />
      </Suspense>
    </>
  );
}
