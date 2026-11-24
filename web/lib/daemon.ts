// Browser-side client for the local PC program. Contract: ../../DAEMON_API.md

export const DAEMON_URL = process.env.NEXT_PUBLIC_DAEMON_URL ?? "http://localhost:47301";

/**
 * NoAccessibility: Mac only, the PC program has not been allowed to use Accessibility (System Settings).
 * DaemonBroken: Mac only, the PC program's KakaoTalk helper is missing.
 */
export type DaemonState =
  | "Ready"
  | "GetKaoFriends"
  | "SendMessage"
  | "NotRunning"
  | "LoggedOut"
  | "Locked"
  | "NoAccessibility"
  | "DaemonBroken"
  | "ShuttingDown";

export type DaemonStatus = {
  status: DaemonState | string;
  version?: string;
  current_sync_cnt?: number;
  /** While sending: recipients handled so far. */
  current_sent_order?: number;
  /** True when this PC program can send images (Mac and Windows PC programs from 0.1.1). */
  images?: boolean;
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

/** States where KakaoTalk (or the PC program's permissions) must be fixed before reading or sending. */
export const KAKAO_BLOCKING_STATES = new Set(["NotRunning", "LoggedOut", "Locked", "NoAccessibility", "DaemonBroken"]);

export const DAEMON_STATE_LABELS: Record<string, string> = {
  Ready: "대기 중",
  GetKaoFriends: "친구 불러오는 중",
  SendMessage: "발송 중",
  NotRunning: "카카오톡 꺼짐",
  LoggedOut: "카카오톡 로그아웃",
  Locked: "카카오톡 잠금",
  NoAccessibility: "손쉬운 사용 권한 필요",
  DaemonBroken: "PC 프로그램 설치 문제 (다시 설치 필요)",
  ShuttingDown: "PC 프로그램 종료 중",
};

/** POST /send refusals (DAEMON_API.md), worded for the user. */
const BAD_REQUEST_LABELS: Record<string, string> = {
  images_not_supported: "이 PC 프로그램은 이미지를 보낼 수 없습니다. 앱을 새 버전으로 업데이트해 주세요.",
  "unsupported image type": "PC 프로그램이 보낼 수 없는 이미지 형식입니다. PNG·JPG·GIF 로 바꿔 주세요.",
  "not a valid image": "이미지 파일이 손상되었거나 열 수 없습니다.",
  "image too large or empty": "이미지가 너무 크거나 비어 있습니다 (장당 10MB까지).",
  "at most 5 images": "이미지는 5장까지 보낼 수 있습니다.",
  "text or images required": "보낼 문구나 이미지가 없습니다.",
};

/** A refusal or error answered by the PC program itself; its message is written for the user. */
export class DaemonError extends Error {}

async function call<T>(path: string, init?: RequestInit, timeoutMs = 4000): Promise<T> {
  const res = await fetch(`${DAEMON_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 409) {
    // Busy or not ready: the body says which state, so say that instead of a bare status code.
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    const state = body?.status;
    if (state) throw new DaemonError(`PC 프로그램이 지금 받을 수 없습니다: ${DAEMON_STATE_LABELS[state] ?? state}`);
  }
  if (res.status === 400) {
    // A refused request (mostly images the PC program cannot send): say why instead of a bare 400.
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const label = body?.error ? BAD_REQUEST_LABELS[body.error] : undefined;
    if (label) throw new DaemonError(label);
  }
  if (!res.ok) throw new DaemonError(`PC 프로그램 응답 오류 (${res.status})`);
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
  input_not_empty: "채팅방 입력창에 쓰던 글이 있어 보내지 않음",
  partial_sent: "일부만 보냄 (문구나 이미지 중 일부) — 채팅방에서 확인하세요",
  unknown_result: "보냈는지 알 수 없음 (PC 프로그램이 중간에 멈춤) — 채팅방에서 확인하세요",
  dry_run: "시험 실행(dry-run)이라 실제로 보내지 않음",
};

/** Starts sending; the payload comes from the getSendPayload server action. */
export const startSend = (payload: unknown) =>
  call<{ ok: boolean }>("/send", { method: "POST", body: JSON.stringify(payload) }, 30000);

export const getSendResult = () => call<SendResult>("/send/result");

export const stopSend = () => call<{ ok: boolean }>("/send/stop", { method: "POST", body: "{}" });
