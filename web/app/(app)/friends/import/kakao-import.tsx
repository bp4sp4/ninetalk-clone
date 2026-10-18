"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { NoticeBar } from "@/components/notice-bar";
import { useAction } from "@/components/use-action";
import { addFriends } from "@/lib/actions";
import type { Group, SenderType } from "@/lib/data";
import {
  DAEMON_STATE_LABELS,
  getDaemonStatus,
  getSyncedFriends,
  startFriendSync,
  stopFriendSync,
} from "@/lib/daemon";

const POLL_MS = 700;
const BLOCKING_STATES = new Set(["NotRunning", "LoggedOut", "Locked"]);

type Phase = "checking" | "offline" | "idle" | "syncing" | "review";

// key: the name as the PC program read it; name: what will be registered (the user can correct OCR misreads).
type Candidate = { key: string; name: string; kakaoCount: number; uncertain: boolean; registered: boolean };

type ReadSummary = { total: number | null; read: number; unreadable: number; keyword: string | null };

export function KakaoImport({ existingNames, groups }: { existingNames: string[]; groups: Group[] }) {
  const { pending, notice, setNotice, run } = useAction();

  const [phase, setPhase] = useState<Phase>("checking");
  const [daemonState, setDaemonState] = useState<string>("");
  const [keyword, setKeyword] = useState("");
  const [syncKeyword, setSyncKeyword] = useState<string | null>(null);
  const [syncCount, setSyncCount] = useState(0);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [summary, setSummary] = useState<ReadSummary | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showRegistered, setShowRegistered] = useState(false);
  const [uncertainOnly, setUncertainOnly] = useState(false);
  const [senderType, setSenderType] = useState<SenderType>("Honorific");
  const [groupId, setGroupId] = useState("");

  const existing = useMemo(() => new Set(existingNames), [existingNames]);

  const checkDaemon = useCallback(async () => {
    setPhase("checking");
    try {
      const { status } = await getDaemonStatus();
      setDaemonState(status);
      setPhase(status === "GetKaoFriends" ? "syncing" : "idle");
    } catch {
      setPhase("offline");
    }
  }, []);

  useEffect(() => {
    // Initial probe of the local PC program; state updates land after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    checkDaemon();
  }, [checkDaemon]);

  const loadResult = useCallback(async () => {
    try {
      const result = await getSyncedFriends();
      const byName = new Map<string, { kakaoCount: number; uncertain: boolean }>();
      result.friend_list.forEach(({ name, ocr_uncertain }) => {
        const entry = byName.get(name) ?? { kakaoCount: 0, uncertain: false };
        byName.set(name, { kakaoCount: entry.kakaoCount + 1, uncertain: entry.uncertain || ocr_uncertain === true });
      });
      const list = [...byName].map(([name, entry]) => ({ key: name, name, ...entry, registered: existing.has(name) }));
      setCandidates(list);
      setSummary({
        total: result.kakao_friend_count ?? null,
        read: result.friend_list.length,
        unreadable: result.unreadable_count ?? 0,
        keyword: syncKeyword,
      });
      // Preselect only names that are new, unambiguous and read with confidence.
      setSelected(new Set(list.filter((item) => !item.registered && item.kakaoCount === 1 && !item.uncertain).map((item) => item.key)));
      setUncertainOnly(false);
      setPhase("review");
    } catch {
      setNotice({ tone: "error", text: "불러온 친구 목록을 받지 못했습니다. PC 프로그램을 확인해 주세요." });
      setPhase("idle");
    }
  }, [existing, syncKeyword, setNotice]);

  // While syncing, follow the PC program's progress until it returns to Ready.
  useEffect(() => {
    if (phase !== "syncing") return;
    let failures = 0;
    const timer = setInterval(async () => {
      try {
        const status = await getDaemonStatus();
        failures = 0;
        setDaemonState(status.status);
        setSyncCount(status.current_sync_cnt ?? 0);
        if (status.status === "GetKaoFriends") return;
        clearInterval(timer);
        if (BLOCKING_STATES.has(status.status)) {
          setNotice({ tone: "error", text: `카카오톡 상태를 확인해 주세요: ${DAEMON_STATE_LABELS[status.status] ?? status.status}` });
          setPhase("idle");
          return;
        }
        // A failed read still ends in Ready; show why, along with whatever was read before it stopped.
        if (status.last_error) {
          setNotice({ tone: "error", text: `친구 목록을 끝까지 읽지 못했습니다: ${status.last_error} (읽은 데까지만 보여 드립니다)` });
        }
        loadResult();
      } catch {
        if (++failures >= 3) {
          clearInterval(timer);
          setNotice({ tone: "error", text: "PC 프로그램과 연결이 끊어졌습니다." });
          setPhase("offline");
        }
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [phase, loadResult, setNotice]);

  const start = async (mode: "Start-all" | "Start-search") => {
    if (mode === "Start-search" && !keyword.trim()) {
      setNotice({ tone: "error", text: "검색할 이름을 입력하세요." });
      return;
    }
    setNotice(null);
    try {
      const status = await getDaemonStatus();
      if (BLOCKING_STATES.has(status.status)) {
        setDaemonState(status.status);
        setNotice({ tone: "error", text: `카카오톡이 준비되지 않았습니다: ${DAEMON_STATE_LABELS[status.status] ?? status.status}` });
        return;
      }
      await startFriendSync(mode, mode === "Start-search" ? keyword.trim() : undefined);
      setSyncKeyword(mode === "Start-search" ? keyword.trim() : null);
      setSyncCount(0);
      setPhase("syncing");
    } catch {
      setNotice({ tone: "error", text: "불러오기를 시작하지 못했습니다. PC 프로그램이 다른 작업 중인지 확인해 주세요." });
    }
  };

  const stop = async () => {
    try {
      await stopFriendSync();
    } finally {
      loadResult();
    }
  };

  // Duplicates are counted on the names that will be registered, so a correction that collides with another friend shows up.
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    candidates.forEach((item) => {
      const name = item.name.trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + item.kakaoCount);
    });
    return counts;
  }, [candidates]);
  const sameNameCount = (item: Candidate) => nameCounts.get(item.name.trim()) ?? 0;

  const visible = candidates.filter((item) => (showRegistered || !item.registered) && (!uncertainOnly || item.uncertain));
  const newCount = candidates.filter((item) => !item.registered).length;
  const duplicateCount = candidates.filter((item) => sameNameCount(item) > 1).length;
  const uncertainCount = candidates.filter((item) => item.uncertain && !item.registered).length;
  const selectedNames = [
    ...new Set(candidates.filter((item) => selected.has(item.key)).map((item) => item.name.trim()).filter(Boolean)),
  ];
  const allVisibleSelected = visible.length > 0 && visible.every((item) => selected.has(item.key));

  const setSelectedKey = (key: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const rename = (key: string, name: string) => {
    setCandidates((list) => list.map((item) => (item.key === key ? { ...item, name } : item)));
    // Fixing a name counts as reviewing it, so pick it up (or drop it if the field was cleared).
    if (!name.trim()) setSelectedKey(key, false);
    else if (name !== key) setSelectedKey(key, !existing.has(name.trim()));
  };

  const importSelected = () =>
    run(
      () => addFriends(selectedNames, senderType, groupId ? Number(groupId) : undefined),
      () => {
        setCandidates((list) => list.map((item) => (selected.has(item.key) ? { ...item, registered: true } : item)));
        setSelected(new Set());
      },
    );

  return (
    <div className="space-y-5">
      <NoticeBar notice={notice} onClose={() => setNotice(null)} />

      {phase === "checking" && <div className="card p-6 text-sm text-muted">PC 프로그램 연결을 확인하는 중…</div>}

      {phase === "offline" && (
        <div className="card space-y-3 p-6">
          <p className="font-medium">PC 프로그램에 연결할 수 없습니다.</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            <li>이 컴퓨터에서 PC 프로그램이 실행 중인지 확인하세요.</li>
            <li>PC 카카오톡이 켜져 있고 로그인되어 있어야 합니다.</li>
            <li>개발 중이라면 web 폴더에서 <code className="rounded bg-black/5 px-1">npm run mock-daemon</code> 으로 테스트용 프로그램을 띄울 수 있습니다.</li>
          </ul>
          <button type="button" className="btn" onClick={checkDaemon}>
            다시 확인
          </button>
        </div>
      )}

      {phase === "idle" && (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="card flex flex-col p-5">
            <h2 className="font-bold">친구 전체 불러오기</h2>
            <p className="mt-1 flex-1 text-sm text-muted">
              친구 탭을 처음부터 끝까지 읽습니다. 친구가 많으면 몇 분 걸릴 수 있고, 그동안 PC 카카오톡을 건드리지 마세요.
            </p>
            <button type="button" className="btn btn-kakao mt-4" onClick={() => start("Start-all")}>
              전체 불러오기
            </button>
          </section>
          <section className="card flex flex-col p-5">
            <h2 className="font-bold">이름으로 찾아 불러오기</h2>
            <p className="mt-1 text-sm text-muted">카카오톡 친구 검색 결과만 가져옵니다.</p>
            <form
              className="mt-4 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                start("Start-search");
              }}
            >
              <input className="input" placeholder="예: 김, 사장님" value={keyword} maxLength={20} onChange={(event) => setKeyword(event.target.value)} />
              <button type="submit" className="btn btn-primary shrink-0">
                찾기
              </button>
            </form>
          </section>
          {daemonState && daemonState !== "Ready" && (
            <p className="text-sm text-muted md:col-span-2">현재 PC 프로그램 상태: {DAEMON_STATE_LABELS[daemonState] ?? daemonState}</p>
          )}
        </div>
      )}

      {phase === "syncing" && (
        <div className="card flex flex-wrap items-center gap-4 p-6">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground" aria-hidden />
          <div className="flex-1">
            <p className="font-medium">카카오톡에서 친구를 읽는 중… {syncCount.toLocaleString("ko-KR")}명</p>
            <p className="text-sm text-muted">끝날 때까지 PC 카카오톡 창을 건드리지 마세요.</p>
          </div>
          <button type="button" className="btn" onClick={stop}>
            여기까지만
          </button>
        </div>
      )}

      {phase === "review" && (
        <section className="card">
          {summary && <ReadSummaryBar summary={summary} />}

          <div className="flex flex-wrap items-center gap-3 border-b border-border p-4 text-sm">
            <p>
              불러온 이름 <strong>{candidates.length}개</strong> · 새로운 친구 <strong>{newCount}명</strong>
              {uncertainCount > 0 && <span className="text-amber-700"> · 확인 필요 {uncertainCount}명</span>}
              {duplicateCount > 0 && <span className="text-amber-700"> · 동명이인 {duplicateCount}명</span>}
            </p>
            <div className="ml-auto flex flex-wrap items-center gap-3">
              {uncertainCount > 0 && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={uncertainOnly} onChange={(event) => setUncertainOnly(event.target.checked)} />
                  확인 필요만 보기
                </label>
              )}
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={showRegistered} onChange={(event) => setShowRegistered(event.target.checked)} />
                이미 등록한 친구도 보기
              </label>
              <button type="button" className="btn" onClick={() => setPhase("idle")}>
                다시 불러오기
              </button>
            </div>
          </div>

          {uncertainCount > 0 && (
            <p className="border-b border-border bg-amber-50 px-4 py-2 text-xs text-amber-800">
              <strong>확인 필요</strong> 표시는 글자 판독이 엇갈린 이름이라 기본으로 선택하지 않았습니다. PC 카카오톡 친구 목록과 비교해 이름을 고친 뒤
              선택하세요(이름을 고치면 자동으로 선택됩니다). 한 글자라도 다르면 보낼 때 친구를 찾지 못하거나 다른 사람에게 갈 수 있습니다.
            </p>
          )}
          {duplicateCount > 0 && (
            <p className="border-b border-border bg-amber-50 px-4 py-2 text-xs text-amber-800">
              동명이인은 이름으로 채팅방을 찾을 때 다른 사람에게 갈 수 있어 기본으로 선택하지 않았습니다. 카카오톡에서 이름을 다르게 바꾼 뒤 다시 불러오는 것을 권장합니다.
            </p>
          )}

          {visible.length === 0 ? (
            <p className="p-10 text-center text-sm text-muted">
              새로 등록할 친구가 없습니다.{" "}
              <Link href="/friends" className="text-accent underline">
                친구 관리로 가기
              </Link>
            </p>
          ) : (
            <ul className="max-h-[32rem] divide-y divide-border/60 overflow-y-auto">
              <li className="sticky top-0 z-10 flex items-center gap-3 bg-surface px-4 py-2 text-xs text-muted">
                <input
                  type="checkbox"
                  aria-label="전체 선택"
                  checked={allVisibleSelected}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      visible.forEach((item) => (allVisibleSelected ? next.delete(item.key) : next.add(item.key)));
                      return next;
                    })
                  }
                />
                이름 <span className="text-muted/80">(눌러서 고칠 수 있습니다)</span>
              </li>
              {visible.map((item) => (
                <CandidateRow
                  key={item.key}
                  item={item}
                  checked={selected.has(item.key)}
                  sameNameCount={sameNameCount(item)}
                  alreadyRegistered={item.registered || existing.has(item.name.trim())}
                  onCheck={(on) => setSelectedKey(item.key, on)}
                  onRename={(name) => rename(item.key, name)}
                />
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-border p-4">
            <select className="input w-auto" value={senderType} onChange={(event) => setSenderType(event.target.value as SenderType)}>
              <option value="Honorific">존댓말로 보내기</option>
              <option value="TalkDown">반말로 보내기</option>
            </select>
            <select className="input w-auto" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              <option value="">그룹 없이</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name} 그룹에 넣기
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-primary ml-auto" disabled={pending || selectedNames.length === 0} onClick={importSelected}>
              {selectedNames.length}명 등록하기
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function ReadSummaryBar({ summary }: { summary: ReadSummary }) {
  const { total, read, unreadable, keyword } = summary;
  const head = keyword
    ? `'${keyword}'(이)가 들어간 이름 ${read}명을 찾았습니다`
    : total !== null
      ? `PC 카카오톡 친구 ${total}명 중 ${read}명을 읽었습니다`
      : `PC 카카오톡에서 친구 ${read}명을 읽었습니다`;
  return (
    <div className="border-b border-border bg-black/[0.02] px-4 py-3 text-sm">
      <p className="font-medium">
        {head}
        {unreadable > 0 && <span className="text-danger">, {unreadable}명은 이름을 읽지 못했습니다</span>}.
      </p>
      {unreadable > 0 && (
        <p className="mt-0.5 text-xs text-muted">
          {keyword ? "이름을 읽지 못한 친구는 검색 결과에서 빠졌을 수 있습니다. " : "읽지 못한 친구는 목록에 없습니다. "}
          필요하면{" "}
          <Link href="/friends" className="text-accent underline">
            친구 관리
          </Link>
          에서 이름을 직접 추가하세요.
        </p>
      )}
    </div>
  );
}

function CandidateRow({
  item,
  checked,
  sameNameCount,
  alreadyRegistered,
  onCheck,
  onRename,
}: {
  item: Candidate;
  checked: boolean;
  sameNameCount: number;
  alreadyRegistered: boolean;
  onCheck: (on: boolean) => void;
  onRename: (name: string) => void;
}) {
  const edited = item.name !== item.key;
  const needsCheck = item.uncertain && !edited;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-sm hover:bg-black/[0.015]">
      <input type="checkbox" aria-label={`${item.name || item.key} 선택`} checked={checked} disabled={!item.name.trim()} onChange={(event) => onCheck(event.target.checked)} />
      <input
        className={`w-48 rounded-md border px-2 py-1 outline-none transition focus:border-foreground/40 focus:bg-surface focus:ring-2 focus:ring-foreground/10 ${
          needsCheck ? "border-amber-300 bg-amber-50/70" : "border-transparent bg-transparent hover:border-border"
        }`}
        aria-label={`${item.key} 이름 고치기`}
        value={item.name}
        maxLength={50}
        spellCheck={false}
        onChange={(event) => onRename(event.target.value)}
      />
      {needsCheck && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">확인 필요</span>}
      {edited && (
        <span className="flex items-center gap-1 text-[11px] text-muted">
          <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-800">수정됨</span>
          읽은 이름: {item.key}
          <button type="button" className="underline hover:text-foreground" onClick={() => onRename(item.key)}>
            되돌리기
          </button>
        </span>
      )}
      {sameNameCount > 1 && (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">동명이인 {sameNameCount}</span>
      )}
      {alreadyRegistered && <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[11px] text-muted">등록됨</span>}
    </li>
  );
}
