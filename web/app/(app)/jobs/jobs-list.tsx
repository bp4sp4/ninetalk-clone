"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { NoticeBar } from "@/components/notice-bar";
import { useAction } from "@/components/use-action";
import { cancelJob, getSendPayload, recordSendResults } from "@/lib/actions";
import type { JobSummary } from "@/lib/data";
import {
  DAEMON_STATE_LABELS,
  DaemonError,
  KAKAO_BLOCKING_STATES,
  SEND_ERROR_LABELS,
  getDaemonStatus,
  getSendResult,
  startSend,
  stopSend,
  type DaemonStatus,
  type SendRunState,
} from "@/lib/daemon";

const STATUS: Record<JobSummary["status"], { label: string; className: string }> = {
  queued: { label: "대기 중", className: "bg-amber-100 text-amber-800" },
  sending: { label: "발송 중", className: "bg-blue-100 text-blue-800" },
  done: { label: "완료", className: "bg-emerald-100 text-emerald-800" },
  canceled: { label: "취소됨", className: "bg-black/[0.06] text-muted" },
};

const POLL_MS = 1500;
const RUN_END: Record<Exclude<SendRunState, "running">, string> = {
  done: "발송을 마쳤습니다.",
  stopped: "발송을 중단했습니다. 남은 사람은 대기 중으로 돌아갑니다.",
  failed: "PC 프로그램이 발송을 멈췄습니다(카카오톡 상태를 확인하세요). 남은 사람은 대기 중으로 돌아갑니다.",
};

// SQLite datetime('now') is UTC without a zone suffix.
const formatTime = (value: string) =>
  new Date(`${value.replace(" ", "T")}Z`).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });

type ActiveRun = { jobId: number; handled: number; total: number };

type Support = { images: boolean; files: boolean };
const supportOf = (status: DaemonStatus): Support => ({ images: status.images === true, files: status.files === true });

/** "사진 2장", "파일 1개", "사진 1장·파일 1개". */
function attachmentLabel(job: JobSummary) {
  const photos = job.fileCount - job.documentCount;
  return [photos > 0 && `사진 ${photos}장`, job.documentCount > 0 && `파일 ${job.documentCount}개`].filter(Boolean).join("·");
}

/** Why this PC program cannot send the job's attachments, or null. */
function unsupportedReason(job: JobSummary, support: Support) {
  if (job.documentCount > 0 && !support.files) return "이 PC 프로그램은 파일을 보낼 수 없습니다(지금은 Windows PC 프로그램만 지원).";
  if (job.fileCount > job.documentCount && !support.images) return "이 PC 프로그램은 사진을 보낼 수 없습니다. 앱을 새 버전으로 업데이트해 주세요.";
  return null;
}

export function JobsList({ jobs }: { jobs: JobSummary[] }) {
  const { pending, notice, setNotice, run } = useAction();
  const [active, setActive] = useState<ActiveRun | null>(null);
  const [starting, setStarting] = useState(false);
  // What the PC program can send besides text (images: Mac and Windows; files: Windows). null = unknown.
  const [support, setSupport] = useState<Support | null>(null);
  useEffect(() => {
    getDaemonStatus()
      .then((status) => setSupport(supportOf(status)))
      .catch(() => setSupport(null));
  }, []);
  // Results already written to the server for the active run (the daemon returns the whole list each time).
  const recorded = useRef(0);
  const polling = useRef(false);

  const follow = useCallback((jobId: number, total: number, alreadyRecorded = 0) => {
    recorded.current = alreadyRecorded;
    setActive({ jobId, handled: alreadyRecorded, total });
  }, []);

  // While a run is active, copy the PC program's results to the server until it stops.
  useEffect(() => {
    if (!active) return;
    let failures = 0;
    const timer = setInterval(async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const result = await getSendResult();
        failures = 0;
        if (result.job_id !== active.jobId) return;
        const finished = result.state !== "running";
        const fresh = result.results.slice(recorded.current);
        if (fresh.length > 0 || finished) {
          await recordSendResults(active.jobId, fresh, finished);
          recorded.current = result.results.length;
        }
        if (finished) {
          clearInterval(timer);
          setActive(null);
          setNotice({ tone: result.state === "done" ? "ok" : "error", text: RUN_END[result.state as Exclude<SendRunState, "running">] });
        } else {
          setActive((current) => current && { ...current, handled: result.results.length });
        }
      } catch {
        if (++failures >= 5) {
          clearInterval(timer);
          setActive(null);
          setNotice({ tone: "error", text: "PC 프로그램과 연결이 끊어졌습니다. 이 화면을 다시 열면 결과를 이어서 받습니다." });
        }
      } finally {
        polling.current = false;
      }
    }, POLL_MS);
    return () => clearInterval(timer);
    // Restart only for a different run; progress updates must not reset the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.jobId]);

  // A job left "sending" (tab closed or reloaded mid-run): pick up the PC program's results.
  // Not while start() runs: the job is already "sending" then, but the PC program still holds the previous
  // run of the same job, which would look finished and put the job back to "queued" mid-send.
  const sendingJob = jobs.find((job) => job.status === "sending");
  useEffect(() => {
    if (!sendingJob || active || starting) return;
    let canceled = false;
    getSendResult()
      .then(async (result) => {
        if (canceled || result.job_id !== sendingJob.id) return;
        if (result.state === "running") follow(sendingJob.id, sendingJob.total);
        else await recordSendResults(sendingJob.id, result.results, true);
      })
      .catch(() => {
        /* PC program offline: the row offers "대기로 되돌리기" */
      });
    return () => {
      canceled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendingJob?.id, starting]);

  const start = async (job: JobSummary) => {
    const remaining = job.total - job.sent - job.failed;
    if (job.fileCount > 0) {
      // Ask before the confirm dialog: a request the PC program would refuse should not ask "send?" first.
      const current = await getDaemonStatus()
        .then(supportOf)
        .catch(() => null);
      // null: the PC program did not answer — that says nothing about attachments, so the button stays usable.
      setSupport(current);
      if (current === null) {
        setNotice({ tone: "error", text: "PC 프로그램이 켜져 있지 않습니다. PC 프로그램을 실행한 뒤 다시 눌러 주세요." });
        return;
      }
      const refusal = unsupportedReason(job, current);
      if (refusal) {
        setNotice({ tone: "error", text: refusal });
        return;
      }
    }
    if (
      !confirm(
        `${remaining}명에게 PC 카카오톡으로 실제 메시지를 보냅니다${job.fileCount > 0 ? ` (${attachmentLabel(job)} 포함)` : ""}.\n` +
          "보내는 동안 이 화면을 열어 두고, PC 카카오톡은 건드리지 마세요.",
      )
    )
      return;
    setNotice(null);
    setStarting(true);
    try {
      let status: string;
      try {
        status = (await getDaemonStatus()).status;
      } catch {
        setNotice({ tone: "error", text: "PC 프로그램이 켜져 있지 않습니다. PC 프로그램을 실행한 뒤 다시 눌러 주세요." });
        return;
      }
      if (status !== "Ready") {
        setNotice({
          tone: "error",
          text: KAKAO_BLOCKING_STATES.has(status)
            ? `카카오톡이 준비되지 않았습니다: ${DAEMON_STATE_LABELS[status] ?? status}`
            : `PC 프로그램이 다른 작업 중입니다: ${DAEMON_STATE_LABELS[status] ?? status}`,
        });
        return;
      }

      const loaded = await getSendPayload(job.id);
      if (!loaded.ok) {
        setNotice({ tone: "error", text: loaded.error });
        return;
      }
      try {
        await startSend(loaded.payload);
      } catch (error) {
        // getSendPayload marked the job as sending; put it back in the queue.
        await recordSendResults(job.id, [], true);
        // Only the PC program's own answers are worded for the user; network errors ("Failed to fetch") are not.
        const reason = error instanceof DaemonError ? error.message : "PC 프로그램이 켜져 있는지 확인해 주세요.";
        setNotice({ tone: "error", text: `PC 프로그램이 발송을 시작하지 못했습니다. ${reason}` });
        return;
      }
      follow(job.id, loaded.payload.recipients.length);
    } finally {
      setStarting(false);
    }
  };

  // Arriving from the composer (/jobs?send=<id>): offer to send the request just made. start() still asks.
  const router = useRouter();
  const sendParam = Number(useSearchParams().get("send"));
  const offered = useRef(false);
  useEffect(() => {
    if (!sendParam || offered.current || active) return;
    const job = jobs.find((item) => item.id === sendParam && item.status === "queued");
    if (!job) return;
    offered.current = true;
    router.replace("/jobs", { scroll: false });
    // After the page has painted, so the list is visible behind the confirm dialog.
    setTimeout(() => start(job), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendParam, jobs]);

  if (jobs.length === 0) {
    return (
      <div className="card p-10 text-center text-sm text-muted">
        아직 발송 요청이 없습니다.{" "}
        <Link href="/compose" className="text-accent underline">
          메시지 작성
        </Link>
        에서 첫 요청을 만들어 보세요.
      </div>
    );
  }

  return (
    <div>
      <NoticeBar notice={notice} onClose={() => setNotice(null)} />
      {active && (
        <div className="card mb-4 flex flex-wrap items-center gap-3 p-4" role="status">
          <div className="min-w-0 flex-1">
            <p className="font-medium">PC 카카오톡으로 보내는 중 · {active.handled} / {active.total}명 처리</p>
            <p className="text-xs text-muted">이 화면을 닫지 마세요. 사람이 보내는 속도보다 느리게 한 명씩 보냅니다.</p>
            <div className="mt-2 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-black/10">
              <div className="h-full bg-accent" style={{ width: `${active.total ? (active.handled / active.total) * 100 : 0}%` }} />
            </div>
          </div>
          <button type="button" className="btn" onClick={() => stopSend().catch(() => undefined)}>
            중단
          </button>
        </div>
      )}
      <ul className="card divide-y divide-border">
        {jobs.map((job) => {
          const status = STATUS[job.status];
          const progress = job.total ? Math.round(((job.sent + job.failed) / job.total) * 100) : 0;
          const isActive = active?.jobId === job.id;
          return (
            <li key={job.id} className="flex flex-wrap items-center gap-3 p-4">
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.className}`}>{status.label}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{job.title}</p>
                <p className="text-xs text-muted">
                  {formatTime(job.createdAt)} · {job.total}명{job.fileCount > 0 && ` · ${attachmentLabel(job)}`}
                  {(job.sent > 0 || job.failed > 0) && ` · 성공 ${job.sent} / 실패 ${job.failed}`}
                </p>
                {job.status === "sending" && (
                  <div className="mt-2 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-black/10">
                    <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
                  </div>
                )}
                {job.failures.length > 0 && (
                  <details className="mt-1 text-xs text-muted">
                    <summary className="cursor-pointer">실패 {job.failed}명 보기</summary>
                    <ul className="mt-1 space-y-0.5">
                      {job.failures.map((failure, index) => (
                        <li key={index}>
                          {failure.name} — {SEND_ERROR_LABELS[failure.error ?? ""] ?? failure.error ?? "알 수 없음"}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {job.status === "queued" && support && unsupportedReason(job, support) && (
                  <p className="mt-1 text-xs text-muted">{unsupportedReason(job, support)}</p>
                )}
              </div>
              {job.status === "queued" && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={starting || pending || active !== null || (support !== null && unsupportedReason(job, support) !== null)}
                    onClick={() => start(job)}
                  >
                    PC 프로그램으로 발송
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={pending || starting}
                    onClick={() => {
                      if (confirm("이 발송 요청을 취소할까요?")) run(() => cancelJob(job.id));
                    }}
                  >
                    취소
                  </button>
                </>
              )}
              {job.status === "sending" && !isActive && (
                <button
                  type="button"
                  className="btn"
                  disabled={pending}
                  title="PC 프로그램이 이 요청을 보내고 있지 않을 때만 쓰세요."
                  onClick={() => {
                    if (confirm("PC 프로그램이 이 요청을 보내고 있지 않나요? 남은 사람을 대기 중으로 되돌립니다."))
                      run(() => recordSendResults(job.id, [], true));
                  }}
                >
                  대기로 되돌리기
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
