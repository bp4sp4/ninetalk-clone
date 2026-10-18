"use client";

import { useCallback, useState, useTransition } from "react";
import type { ActionResult } from "@/lib/actions";

export type Notice = { tone: "ok" | "error"; text: string } | null;

/** Runs a server action in a transition and keeps its result message for display. */
export function useAction() {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);

  const run = useCallback((action: () => Promise<ActionResult>, onSuccess?: (result: Extract<ActionResult, { ok: true }>) => void) => {
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          setNotice(result.message ? { tone: "ok", text: result.message } : null);
          onSuccess?.(result);
        } else {
          setNotice({ tone: "error", text: result.error });
        }
      } catch {
        setNotice({ tone: "error", text: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." });
      }
    });
  }, []);

  return { pending, notice, setNotice, run };
}
