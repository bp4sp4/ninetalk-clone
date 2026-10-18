"use client";

import type { Notice } from "./use-action";

export function NoticeBar({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  if (!notice) return null;
  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={`mb-4 flex items-start justify-between gap-3 rounded-lg px-3 py-2 text-sm ${
        notice.tone === "error" ? "bg-danger/10 text-danger" : "bg-emerald-50 text-emerald-800"
      }`}
    >
      <span>{notice.text}</span>
      <button type="button" onClick={onClose} className="shrink-0 opacity-60 hover:opacity-100" aria-label="닫기">
        ✕
      </button>
    </div>
  );
}
