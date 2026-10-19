// Send speed settings shared by the composer (client) and the server actions.
// Same shape as the original NineTalk: interval between recipients, and how often KakaoTalk is restarted.

/** "restart": quit and relaunch PC KakaoTalk every `splitCount` recipients. "normal": never restart. */
export type SendMode = "restart" | "normal";
export type SpeedPreset = "slow" | "normal" | "fast" | "custom";

export type SpeedSetting = { intervalMs: number; splitCount: number; mode: SendMode };

export const SPEED_PRESETS: Record<Exclude<SpeedPreset, "custom">, SpeedSetting & { label: string }> = {
  slow: { label: "느리게", intervalMs: 1200, splitCount: 30, mode: "restart" },
  normal: { label: "보통 (추천)", intervalMs: 800, splitCount: 50, mode: "restart" },
  fast: { label: "빠르게", intervalMs: 400, splitCount: 100, mode: "restart" },
};

export const CUSTOM_LIMITS = { minIntervalMs: 200, maxIntervalMs: 2000, stepMs: 100, minSplit: 1, maxSplit: 999 };

export const isSpeedPreset = (value: unknown): value is SpeedPreset =>
  value === "slow" || value === "normal" || value === "fast" || value === "custom";

/** Validates a custom setting; returns an error message or null. */
export function customSettingError({ intervalMs, splitCount, mode }: SpeedSetting): string | null {
  const { minIntervalMs, maxIntervalMs, stepMs, minSplit, maxSplit } = CUSTOM_LIMITS;
  if (!Number.isInteger(intervalMs) || intervalMs < minIntervalMs || intervalMs > maxIntervalMs || intervalMs % stepMs !== 0) {
    return `발송 간격은 ${minIntervalMs}~${maxIntervalMs}ms, ${stepMs}ms 단위여야 합니다.`;
  }
  if (!Number.isInteger(splitCount) || splitCount < minSplit || splitCount > maxSplit) {
    return `분할 발송 횟수는 ${minSplit}~${maxSplit} 사이여야 합니다.`;
  }
  if (mode !== "restart" && mode !== "normal") return "발송 방식이 올바르지 않습니다.";
  return null;
}

/** Old 1~5 speed_rate (kept for PC programs that only know it) from an interval. */
export function speedRateFor(intervalMs: number): number {
  if (intervalMs >= 1600) return 1;
  if (intervalMs >= 1100) return 2;
  if (intervalMs >= 700) return 3;
  if (intervalMs >= 350) return 4;
  return 5;
}

/** Interval for jobs saved before interval_ms existed (speed_rate 1~5 only). */
export const LEGACY_INTERVAL_MS: Record<number, number> = { 1: 2000, 2: 1200, 3: 800, 4: 400, 5: 200 };

export const formatInterval = (ms: number) => `${(ms / 1000).toFixed(1)}초`;

export function describeSetting({ intervalMs, splitCount, mode }: SpeedSetting): string {
  return mode === "restart"
    ? `${formatInterval(intervalMs)} 간격 · ${splitCount}명마다 카카오톡 재시작`
    : `${formatInterval(intervalMs)} 간격 · 재시작 없이 계속`;
}
