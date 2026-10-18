"use client";

import { useEffect, useState } from "react";
import { DAEMON_STATE_LABELS, DAEMON_URL, getDaemonStatus } from "@/lib/daemon";

const POLL_MS = 5000;

type State = { kind: "checking" } | { kind: "offline" } | { kind: "online"; status: string; version?: string };

/** Polls the local PC program's /status endpoint (read-only). */
export function DaemonStatus() {
  const [state, setState] = useState<State>({ kind: "checking" });

  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const data = await getDaemonStatus();
        if (!stopped) setState({ kind: "online", status: data.status, version: data.version });
      } catch {
        if (!stopped) setState({ kind: "offline" });
      }
    }
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const ready = state.kind === "online" && state.status === "Ready";
  const dot = state.kind === "checking" ? "bg-muted" : state.kind === "offline" ? "bg-danger" : ready ? "bg-emerald-500" : "bg-amber-500";
  const text =
    state.kind === "checking"
      ? "PC 프로그램 확인 중"
      : state.kind === "offline"
        ? "PC 프로그램 미연결"
        : `PC 프로그램 ${DAEMON_STATE_LABELS[state.status] ?? state.status}`;

  return (
    <div className="flex items-center gap-2 rounded-lg bg-black/[0.03] px-3 py-2 text-xs text-muted" title={DAEMON_URL}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span>{text}</span>
      {state.kind === "online" && state.version && <span className="ml-auto">v{state.version}</span>}
    </div>
  );
}
