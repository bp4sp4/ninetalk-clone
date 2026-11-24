"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { NoticeBar } from "@/components/notice-bar";
import { useAction } from "@/components/use-action";
import { createSendJob } from "@/lib/actions";
import { MAX_ATTACHMENTS, MAX_TOTAL_BYTES, attachmentProblem, formatBytes, isImageType } from "@/lib/attachments";
import type { Friend, Group, SenderType } from "@/lib/data";
import { NAME_TOKEN, renderMessage } from "@/lib/message";
import {
  CUSTOM_LIMITS,
  SPEED_PRESETS,
  customSettingError,
  describeSetting,
  formatInterval,
  type SendMode,
  type SpeedPreset,
  type SpeedSetting,
} from "@/lib/send-speed";

const SPEED_OPTIONS: { key: SpeedPreset; label: string; detail: string }[] = [
  ...(Object.entries(SPEED_PRESETS) as [Exclude<SpeedPreset, "custom">, (typeof SPEED_PRESETS)["slow"]][]).map(([key, preset]) => ({
    key,
    label: preset.label,
    detail: `${preset.intervalMs}ms · ${preset.splitCount}명마다`,
  })),
  { key: "custom", label: "사용자화", detail: "간격·횟수·방식 직접" },
];
const AD_PREFIX = "(광고) ";
const AD_FOOTER = "\n\n무료 수신거부: 이 채팅방에 '수신거부'라고 보내 주세요.";

/** url: a preview for images; null for other files (shown as a file card). */
type Attachment = { file: File; url: string | null };

export function Composer({ groups, friends }: { groups: Group[]; friends: Friend[] }) {
  const { pending, notice, setNotice, run } = useAction();
  const router = useRouter();

  const [groupIds, setGroupIds] = useState<Set<number>>(() => new Set(groups.filter((group) => group.isDefault).map((group) => group.id)));
  const [extraIds, setExtraIds] = useState<Set<number>>(new Set());
  const [friendQuery, setFriendQuery] = useState("");

  const [tab, setTab] = useState<SenderType>("Honorific");
  const [honorific, setHonorific] = useState("");
  const [talkdown, setTalkdown] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [imageFirst, setImageFirst] = useState(false);
  const [speedPreset, setSpeedPreset] = useState<SpeedPreset>("normal");
  const [customInterval, setCustomInterval] = useState(800);
  const [customSplit, setCustomSplit] = useState("50");
  const [customMode, setCustomMode] = useState<SendMode>("restart");
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);

  // Release preview object URLs on unmount; removals revoke their own URL.
  const attachmentsRef = useRef(attachments);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  const revoke = (attachment: Attachment) => attachment.url && URL.revokeObjectURL(attachment.url);
  useEffect(() => () => attachmentsRef.current.forEach(revoke), []);

  const removeAttachment = (index: number) => {
    revoke(attachments[index]);
    setAttachments(attachments.filter((_, i) => i !== index));
  };
  const hasDocuments = attachments.some((attachment) => attachment.url === null);

  const recipients = useMemo(
    () => friends.filter((friend) => extraIds.has(friend.id) || friend.groupIds.some((id) => groupIds.has(id))),
    [friends, groupIds, extraIds],
  );
  const talkdownCount = recipients.filter((friend) => friend.senderType === "TalkDown").length;
  const preview = recipients.find((friend) => friend.id === previewId) ?? recipients[0] ?? null;
  const previewText = preview ? renderMessage(preview.name, preview.senderType, honorific, talkdown) : "";

  const searchResults = useMemo(() => {
    const q = friendQuery.trim().toLowerCase();
    if (!q) return [];
    return friends.filter((friend) => friend.name.toLowerCase().includes(q)).slice(0, 30);
  }, [friends, friendQuery]);

  const currentText = tab === "Honorific" ? honorific : talkdown;
  const setCurrentText = tab === "Honorific" ? setHonorific : setTalkdown;

  const insertAtCursor = (snippet: string) => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? currentText.length;
    const end = el?.selectionEnd ?? currentText.length;
    setCurrentText(currentText.slice(0, start) + snippet + currentText.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  const addAdNotice = () => {
    const withAd = (text: string) => (text.startsWith("(광고)") ? text : AD_PREFIX + text) + (text.includes("수신거부") ? "" : AD_FOOTER);
    setHonorific(withAd(honorific));
    if (talkdown.trim()) setTalkdown(withAd(talkdown));
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const incoming = [...list];
    const problems = incoming.map(attachmentProblem);
    let total = attachments.reduce((sum, attachment) => sum + attachment.file.size, 0);
    const accepted: File[] = [];
    let overTotal = false;
    incoming.forEach((file, index) => {
      if (problems[index] || attachments.length + accepted.length >= MAX_ATTACHMENTS) return;
      if (total + file.size > MAX_TOTAL_BYTES) {
        overTotal = true;
        return;
      }
      total += file.size;
      accepted.push(file);
    });
    setAttachments([
      ...attachments,
      ...accepted.map((file) => ({ file, url: isImageType(file.type) ? URL.createObjectURL(file) : null })),
    ]);
    const firstProblem = problems.find(Boolean);
    if (firstProblem) setNotice({ tone: "error", text: firstProblem });
    else if (overTotal) setNotice({ tone: "error", text: "첨부한 사진·파일은 합쳐서 25MB까지입니다." });
    else if (accepted.length < incoming.length) setNotice({ tone: "error", text: `사진·파일은 ${MAX_ATTACHMENTS}개까지 첨부할 수 있습니다.` });
  };

  const toggleSet = (setter: typeof setGroupIds, id: number) =>
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = () => {
    const form = new FormData();
    form.set("honorific", honorific);
    form.set("talkdown", talkdown);
    form.set("speedPreset", speedPreset);
    if (speedPreset === "custom") {
      form.set("intervalMs", String(customInterval));
      form.set("splitSendCount", customSplit);
      form.set("sendMode", customMode);
    }
    if (imageFirst) form.set("imageFirst", "on");
    groupIds.forEach((id) => form.append("groupIds", String(id)));
    extraIds.forEach((id) => form.append("friendIds", String(id)));
    attachments.forEach((attachment) => form.append("files", attachment.file));

    run(
      () => createSendJob(form),
      (result) => {
        // Straight on to the jobs page, which asks to confirm and hands the request to the PC program.
        if (result.id) {
          router.push(`/jobs?send=${result.id}`);
          return;
        }
        setSubmitted(true);
        setHonorific("");
        setTalkdown("");
        attachments.forEach(revoke);
        setAttachments([]);
        setExtraIds(new Set());
      },
    );
  };

  // The effective speed; null while a custom setting is out of range.
  const speedSetting: SpeedSetting | null = (() => {
    if (speedPreset !== "custom") return SPEED_PRESETS[speedPreset];
    const custom = { intervalMs: customInterval, splitCount: Number(customSplit), mode: customMode };
    return customSettingError(custom) ? null : custom;
  })();

  const canSubmit = recipients.length > 0 && (honorific.trim() || attachments.length > 0) && speedSetting !== null && !pending;

  return (
    <div>
      <NoticeBar notice={notice} onClose={() => setNotice(null)} />
      {submitted && notice?.tone === "ok" && (
        <p className="-mt-2 mb-4 text-sm">
          <Link href="/jobs" className="font-medium text-accent underline">
            발송 내역에서 확인하기 →
          </Link>
        </p>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          <section className="card p-5">
            <h2 className="mb-3 font-bold">1. 받는 사람</h2>
            {groups.length === 0 && friends.length === 0 ? (
              <p className="text-sm text-muted">
                <Link href="/friends" className="text-accent underline">
                  친구 관리
                </Link>
                에서 친구를 먼저 등록하세요.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {groups.map((group) => (
                    <label
                      key={group.id}
                      className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                        groupIds.has(group.id) ? "border-foreground bg-foreground text-white" : "border-border"
                      }`}
                    >
                      <input type="checkbox" className="sr-only" checked={groupIds.has(group.id)} onChange={() => toggleSet(setGroupIds, group.id)} />
                      {group.name}
                      <span className="text-xs opacity-70">{group.memberCount}</span>
                    </label>
                  ))}
                </div>

                <div className="relative mt-4">
                  <input className="input" placeholder="그룹 밖의 친구를 이름으로 찾아 추가" value={friendQuery} onChange={(event) => setFriendQuery(event.target.value)} />
                  {searchResults.length > 0 && (
                    <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-lg">
                      {searchResults.map((friend) => (
                        <li key={friend.id}>
                          <button
                            type="button"
                            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-black/[0.03]"
                            onClick={() => {
                              setExtraIds((current) => new Set(current).add(friend.id));
                              setFriendQuery("");
                            }}
                          >
                            {friend.name}
                            {extraIds.has(friend.id) && <span className="text-xs text-muted">추가됨</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {extraIds.size > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {friends
                      .filter((friend) => extraIds.has(friend.id))
                      .map((friend) => (
                        <span key={friend.id} className="flex items-center gap-1 rounded bg-black/[0.05] px-2 py-0.5 text-xs">
                          {friend.name}
                          <button type="button" aria-label={`${friend.name} 빼기`} onClick={() => toggleSet(setExtraIds, friend.id)}>
                            ✕
                          </button>
                        </span>
                      ))}
                  </div>
                )}

                <p className="mt-4 text-sm">
                  총 <strong>{recipients.length}명</strong>
                  <span className="text-muted">
                    {" "}
                    (존댓말 {recipients.length - talkdownCount} · 반말 {talkdownCount})
                  </span>
                </p>
              </>
            )}
          </section>

          <section className="card p-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="mr-auto font-bold">2. 메시지</h2>
              <div className="flex rounded-lg bg-black/[0.04] p-1 text-sm">
                {(["Honorific", "TalkDown"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setTab(value)}
                    className={`rounded-md px-3 py-1 font-medium ${tab === value ? "bg-surface shadow-sm" : "text-muted"}`}
                  >
                    {value === "Honorific" ? "존댓말" : "반말"}
                  </button>
                ))}
              </div>
            </div>

            <textarea
              ref={textareaRef}
              className="input min-h-44 leading-relaxed"
              maxLength={2000}
              placeholder={
                tab === "Honorific"
                  ? `${NAME_TOKEN}님 안녕하세요! 이번 주 소식 전해드려요.`
                  : `${NAME_TOKEN}아 잘 지내? 이번 주 소식 알려줄게.\n(비워 두면 존댓말 문구가 나갑니다)`
              }
              value={currentText}
              onChange={(event) => setCurrentText(event.target.value)}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" className="btn py-1 text-xs" onClick={() => insertAtCursor(NAME_TOKEN)}>
                + {NAME_TOKEN} 넣기
              </button>
              <button type="button" className="btn py-1 text-xs" onClick={addAdNotice}>
                + 광고 표기·수신거부 문구
              </button>
              <span className="ml-auto text-xs text-muted">{currentText.length} / 2000</span>
            </div>
            <p className="mt-3 text-xs text-muted">
              광고·홍보 메시지라면 받는 분의 사전 동의가 있어야 하고, 맨 앞에 (광고) 표기와 수신거부 방법을 넣어야 합니다(정보통신망법 제50조).
            </p>
          </section>

          <section className="card p-5">
            <h2 className="mb-3 font-bold">3. 사진·파일 (선택)</h2>
            <div className="flex flex-wrap gap-3">
              {attachments.map((attachment, index) => (
                <div key={attachment.url ?? `${attachment.file.name}-${index}`} className="relative h-24 w-24 overflow-hidden rounded-lg border border-border">
                  {attachment.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={attachment.url} alt={attachment.file.name} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-black/[0.03] px-2 text-center">
                      <span className="text-2xl" aria-hidden>
                        📄
                      </span>
                      <span className="line-clamp-2 w-full text-[11px] leading-tight break-all">{attachment.file.name}</span>
                      <span className="text-[10px] text-muted">{formatBytes(attachment.file.size)}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    aria-label={`${attachment.file.name} 빼기`}
                    className="absolute top-1 right-1 rounded-full bg-black/60 px-1.5 text-xs text-white"
                    onClick={() => removeAttachment(index)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {attachments.length < MAX_ATTACHMENTS && (
                <label className="flex h-24 w-24 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted hover:bg-black/[0.02]">
                  <span className="text-xl">＋</span>
                  {attachments.length}/{MAX_ATTACHMENTS}
                  <input
                    type="file"
                    multiple
                    className="sr-only"
                    onChange={(event) => {
                      addFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                </label>
              )}
            </div>
            {attachments.length > 0 && (
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={imageFirst} onChange={(event) => setImageFirst(event.target.checked)} />
                사진·파일을 글보다 먼저 보내기
              </label>
            )}
            <p className="mt-3 text-xs text-muted">
              사진(PNG·JPG·GIF·WebP)은 5MB, 파일(PDF·한글·엑셀·zip 등)은 20MB까지, 합쳐서 25MB·{MAX_ATTACHMENTS}개까지. 실행 파일은 보낼 수 없습니다.
              {hasDocuments && " 파일 발송은 Windows PC 프로그램만 됩니다(맥은 준비 중)."}
            </p>
          </section>

          <section className="card p-5">
            <h2 className="mb-3 font-bold">4. 발송 설정</h2>
            <div className="grid gap-2 sm:grid-cols-4" role="radiogroup" aria-label="발송 속도">
              {SPEED_OPTIONS.map(({ key, label, detail }) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={speedPreset === key}
                  onClick={() => setSpeedPreset(key)}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    speedPreset === key ? "border-accent bg-accent/10 font-medium" : "border-border hover:bg-black/[0.03]"
                  }`}
                >
                  <span className="block">{label}</span>
                  <span className="mt-0.5 block text-xs font-normal text-muted">{detail}</span>
                </button>
              ))}
            </div>

            {speedPreset === "custom" && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="block text-sm sm:col-span-2">
                  <span className="mb-1 flex justify-between">
                    발송 간격 <span className="text-muted">{customInterval}ms ({formatInterval(customInterval)})</span>
                  </span>
                  <input
                    type="range"
                    min={CUSTOM_LIMITS.minIntervalMs}
                    max={CUSTOM_LIMITS.maxIntervalMs}
                    step={CUSTOM_LIMITS.stepMs}
                    value={customInterval}
                    onChange={(event) => setCustomInterval(Number(event.target.value))}
                    className="w-full"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block">분할 발송 횟수</span>
                  <div className="flex items-center gap-2">
                    <input
                      className="input max-w-24"
                      inputMode="numeric"
                      value={customSplit}
                      onChange={(event) => setCustomSplit(event.target.value.replace(/\D/g, "").slice(0, 3))}
                      aria-label="분할 발송 횟수 (1~999)"
                    />
                    <span className="shrink-0 text-muted">명마다</span>
                  </div>
                </label>
                <fieldset className="text-sm">
                  <legend className="mb-1">발송 방식</legend>
                  <label className="mr-4 inline-flex items-center gap-1.5">
                    <input type="radio" name="sendMode" checked={customMode === "restart"} onChange={() => setCustomMode("restart")} />
                    재시작 발송
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <input type="radio" name="sendMode" checked={customMode === "normal"} onChange={() => setCustomMode("normal")} />
                    일반 발송
                  </label>
                </fieldset>
              </div>
            )}

            <p className="mt-3 text-xs text-muted">
              {speedSetting ? describeSetting(speedSetting) : "분할 발송 횟수는 1~999 사이로 넣어 주세요."}
              {speedSetting?.mode === "restart" && " · 재시작하려면 PC 카카오톡 자동 로그인이 켜져 있어야 합니다."}
              <span className="mt-0.5 block">빠를수록 카카오 계정 제한 위험이 커집니다.</span>
            </p>
          </section>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          <section className="card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <h2 className="mr-auto text-sm font-bold">미리보기</h2>
              {recipients.length > 0 && (
                <select
                  className="input w-auto max-w-40 py-1 text-xs"
                  value={preview?.id ?? ""}
                  onChange={(event) => setPreviewId(Number(event.target.value))}
                  aria-label="미리볼 받는 사람"
                >
                  {recipients.slice(0, 500).map((friend) => (
                    <option key={friend.id} value={friend.id}>
                      {friend.name} ({friend.senderType === "Honorific" ? "존댓말" : "반말"})
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="min-h-72 space-y-2 bg-chat p-4">
              {preview ? (
                <>
                  <p className="text-center text-xs text-black/50">{preview.name}님과의 채팅</p>
                  {imageFirst && <PreviewImages attachments={attachments} />}
                  {previewText.trim() && (
                    <div className="ml-auto max-w-[85%] rounded-xl rounded-tr-sm bg-kakao px-3 py-2 text-sm whitespace-pre-wrap text-kakao-ink">
                      {previewText}
                    </div>
                  )}
                  {!imageFirst && <PreviewImages attachments={attachments} />}
                  {!previewText.trim() && attachments.length === 0 && (
                    <p className="pt-10 text-center text-xs text-black/50">문구를 입력하면 여기에 보입니다.</p>
                  )}
                </>
              ) : (
                <p className="pt-24 text-center text-xs text-black/50">받는 사람을 고르면 미리보기가 나옵니다.</p>
              )}
            </div>
          </section>

          <button type="button" className="btn btn-kakao w-full py-3 text-base" disabled={!canSubmit} onClick={submit}>
            {pending ? "요청 만드는 중…" : `${recipients.length}명에게 보내기`}
          </button>
          <p className="text-center text-xs text-muted">발송 내역으로 넘어가 한 번 더 확인한 뒤, PC 프로그램이 PC 카카오톡으로 보냅니다.</p>
        </aside>
      </div>
    </div>
  );
}

function PreviewImages({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="ml-auto flex max-w-[85%] flex-wrap justify-end gap-1">
      {attachments.map((attachment, index) =>
        attachment.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={attachment.url} src={attachment.url} alt="" className="h-28 w-28 rounded-lg object-cover" />
        ) : (
          <div key={`${attachment.file.name}-${index}`} className="flex w-full items-center gap-2 rounded-lg bg-white px-3 py-2 text-xs text-black">
            <span aria-hidden>📄</span>
            <span className="min-w-0 flex-1 truncate">{attachment.file.name}</span>
            <span className="text-black/50">{formatBytes(attachment.file.size)}</span>
          </div>
        ),
      )}
    </div>
  );
}
