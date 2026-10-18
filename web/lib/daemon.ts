// Browser-side client for the local PC program. Contract: ../../DAEMON_API.md

export const DAEMON_URL = process.env.NEXT_PUBLIC_DAEMON_URL ?? "http://localhost:47301";

export type DaemonState = "Ready" | "GetKaoFriends" | "SendMessage" | "NotRunning" | "LoggedOut" | "Locked";

export type DaemonStatus = {
  status: DaemonState | string;
  version?: string;
  current_sync_cnt?: number;
  /** While sending: recipients handled so far. */
  current_sent_order?: number;
  /** Why the last sync failed; the daemon returns to Ready either way. */
  last_error?: string | null;
};

export type SyncMode = "Start-all" | "Start-search" | "Stop";

export type KakaoFriendList = {
  /** ocr_uncertain: the OCR passes disagreed, so the name may be misread. */
  friend_list: { name: string; ocr_uncertain?: boolean }[];
  duplicate_friend_list?: string[];
  /** "친구 N" from KakaoTalk's friend tab header; null when unknown or the read did not finish. */
  kakao_friend_count?: number | null;
  /** Friend rows whose name could not be read (left out of friend_list). */
  unreadable_count?: number;
};

export const DAEMON_STATE_LABELS: Record<string, string> = {
  Ready: "대기 중",
  GetKaoFriends: "친구 불러오는 중",
  SendMessage: "발송 중",
  NotRunning: "카카오톡 꺼짐",
  LoggedOut: "카카오톡 로그아웃",
  Locked: "카카오톡 잠금",
};

async function call<T>(path: string, init?: RequestInit, timeoutMs = 4000): Promise<T> {
  const res = await fetch(`${DAEMON_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`PC 프로그램 응답 오류 (${res.status})`);
  return (await res.json()) as T;
}

export const getDaemonStatus = () => call<DaemonStatus>("/status", undefined, 3000);

export const startFriendSync = (mode: Exclude<SyncMode, "Stop">, keyword?: string) =>
  call<{ ok: boolean }>("/friends/synchronize", { method: "POST", body: JSON.stringify({ mode, option: keyword }) });

export const stopFriendSync = () =>
  call<{ ok: boolean }>("/friends/synchronize", { method: "POST", body: JSON.stringify({ mode: "Stop" }) });

export const getSyncedFriends = () => call<KakaoFriendList>("/friends", undefined, 10000);

export type SendRunState = "running" | "done" | "stopped" | "failed";

export type SendResult = {
  job_id: number | null;
  state: SendRunState;
  results: { id: number; status: "sent" | "failed"; error?: string }[];
};

export const SEND_ERROR_LABELS: Record<string, string> = {
  not_found: "카카오톡 친구에서 찾지 못함",
  duplicate_name: "같은 이름 친구가 여러 명",
  room_mismatch: "채팅방 이름이 달라 보내지 않음",
  send_failed: "전송 실패",
  kakao_not_ready: "카카오톡 준비 안 됨",
};

/** Starts sending; the payload comes from the getSendPayload server action. */
export const startSend = (payload: unknown) =>
  call<{ ok: boolean }>("/send", { method: "POST", body: JSON.stringify(payload) }, 30000);

export const getSendResult = () => call<SendResult>("/send/result");

export const stopSend = () => call<{ ok: boolean }>("/send/stop", { method: "POST", body: "{}" });
