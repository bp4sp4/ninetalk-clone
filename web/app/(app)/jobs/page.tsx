import { Suspense } from "react";
import { PageHeader, PanelSkeleton } from "@/components/page-header";
import { getJobs } from "@/lib/data";
import { JobsList } from "./jobs-list";

async function JobsPanel() {
  const jobs = await getJobs();
  return <JobsList jobs={jobs} />;
}

export default function JobsPage() {
  return (
    <>
      <PageHeader title="발송 내역" description="만든 발송 요청과 진행 상태입니다. 대기 중인 요청은 취소할 수 있습니다." />
      <Suspense fallback={<PanelSkeleton />}>
        <JobsPanel />
      </Suspense>
    </>
  );
}
