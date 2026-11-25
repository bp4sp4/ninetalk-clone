// Message attachments: images (sent as photos) and other files (sent as KakaoTalk files).
// Shared by the compose screen and the server action, so both apply the same rules.

export const MAX_ATTACHMENTS = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
/** All attachments of one message together (the upload and the hand-over to the PC program carry them at once). */
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Programs and scripts: KakaoTalk refuses or warns about them, and they have no place in a bulk message. */
const BLOCKED_EXTENSIONS = new Set(["exe", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs", "js", "jse", "wsf", "dll", "lnk", "app", "pkg", "dmg", "sh", "command"]);

export const isImageType = (mime: string) => IMAGE_TYPES.has(mime);

/** Why a file cannot be attached, or null when it can. */
export function attachmentProblem(file: { name: string; type: string; size: number }): string | null {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (BLOCKED_EXTENSIONS.has(extension)) return `실행 파일은 보낼 수 없습니다: ${file.name}`;
  if (file.size === 0) return `빈 파일입니다: ${file.name}`;
  if (isImageType(file.type)) return file.size > MAX_IMAGE_BYTES ? `사진은 5MB까지입니다: ${file.name}` : null;
  return file.size > MAX_DOCUMENT_BYTES ? `파일은 20MB까지입니다: ${file.name}` : null;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
