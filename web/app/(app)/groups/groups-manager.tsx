"use client";

import { useMemo, useState } from "react";
import { NoticeBar } from "@/components/notice-bar";
import { useAction } from "@/components/use-action";
import {
  addToGroup,
  createGroup,
  deleteGroup,
  moveGroup,
  removeFromGroup,
  renameGroup,
  setDefaultGroup,
} from "@/lib/actions";
import type { Friend, Group } from "@/lib/data";

export function GroupsManager({ groups, friends }: { groups: Group[]; friends: Friend[] }) {
  const { pending, notice, setNotice, run } = useAction();
  const [newName, setNewName] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(groups[0]?.id ?? null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [memberQuery, setMemberQuery] = useState("");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());

  const group = groups.find((item) => item.id === selectedId) ?? groups[0] ?? null;

  const members = useMemo(
    () => (group ? friends.filter((friend) => friend.groupIds.includes(group.id)) : []),
    [friends, group],
  );
  const candidates = useMemo(() => {
    if (!group) return [];
    const q = candidateQuery.trim().toLowerCase();
    return friends.filter((friend) => !friend.groupIds.includes(group.id) && (!q || friend.name.toLowerCase().includes(q)));
  }, [friends, group, candidateQuery]);
  const shownMembers = members.filter((friend) => friend.name.toLowerCase().includes(memberQuery.trim().toLowerCase()));

  const select = (id: number) => {
    setSelectedId(id);
    setRenaming(null);
    setPicked(new Set());
    setMemberQuery("");
    setCandidateQuery("");
  };

  const togglePicked = (id: number) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <NoticeBar notice={notice} onClose={() => setNotice(null)} />

      <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
        <section className="card p-4">
          <form
            className="mb-4 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              run(() => createGroup(newName), () => setNewName(""));
            }}
          >
            <input className="input" placeholder="새 그룹 이름" value={newName} maxLength={30} onChange={(event) => setNewName(event.target.value)} />
            <button type="submit" className="btn btn-primary shrink-0" disabled={pending || !newName.trim()}>
              만들기
            </button>
          </form>

          {groups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">그룹을 먼저 만들어 주세요.</p>
          ) : (
            <ul className="space-y-1">
              {groups.map((item, index) => (
                <li key={item.id}>
                  <div
                    className={`group flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                      item.id === group?.id ? "bg-foreground text-white" : "hover:bg-black/[0.04]"
                    }`}
                  >
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => select(item.id)}>
                      <span className="truncate font-medium">{item.name}</span>
                      {item.isDefault && <span className="rounded bg-kakao px-1.5 text-[10px] font-bold text-kakao-ink">기본</span>}
                      <span className="ml-auto text-xs opacity-70">{item.memberCount}명</span>
                    </button>
                    <span className="flex shrink-0 flex-col text-[10px] leading-none opacity-60">
                      <button type="button" aria-label={`${item.name} 위로`} disabled={pending || index === 0} onClick={() => run(() => moveGroup(item.id, "up"))}>
                        ▲
                      </button>
                      <button
                        type="button"
                        aria-label={`${item.name} 아래로`}
                        disabled={pending || index === groups.length - 1}
                        onClick={() => run(() => moveGroup(item.id, "down"))}
                      >
                        ▼
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {group && (
          <section className="card min-w-0 p-5">
            <div className="mb-5 flex flex-wrap items-center gap-2">
              {renaming !== null ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    run(() => renameGroup(group.id, renaming), () => setRenaming(null));
                  }}
                >
                  <input className="input max-w-xs" value={renaming} autoFocus maxLength={30} onChange={(event) => setRenaming(event.target.value)} />
                  <button type="submit" className="btn btn-primary" disabled={pending}>
                    저장
                  </button>
                  <button type="button" className="btn" onClick={() => setRenaming(null)}>
                    취소
                  </button>
                </form>
              ) : (
                <>
                  <h2 className="mr-auto text-lg font-bold">
                    {group.name} <span className="text-sm font-normal text-muted">{group.memberCount}명</span>
                  </h2>
                  <button type="button" className="btn" onClick={() => setRenaming(group.name)}>
                    이름 변경
                  </button>
                  {!group.isDefault && (
                    <button type="button" className="btn" disabled={pending} onClick={() => run(() => setDefaultGroup(group.id))}>
                      기본 그룹으로
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn text-danger"
                    disabled={pending}
                    onClick={() => {
                      if (confirm(`"${group.name}" 그룹을 삭제할까요? 친구 목록은 그대로 남습니다.`)) {
                        run(() => deleteGroup(group.id), () => setSelectedId(null));
                      }
                    }}
                  >
                    삭제
                  </button>
                </>
              )}
            </div>

            <div className="grid gap-5 xl:grid-cols-2">
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold">그룹 멤버</h3>
                  <input className="input max-w-40 py-1" placeholder="검색" value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} />
                </div>
                <ul className="max-h-[28rem] divide-y divide-border/60 overflow-y-auto rounded-lg border border-border">
                  {shownMembers.length === 0 && <li className="p-6 text-center text-sm text-muted">멤버가 없습니다.</li>}
                  {shownMembers.map((friend) => (
                    <li key={friend.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span>
                        {friend.name}
                        <span className="ml-2 text-xs text-muted">{friend.senderType === "Honorific" ? "존댓말" : "반말"}</span>
                      </span>
                      <button
                        type="button"
                        className="text-xs text-muted hover:text-danger"
                        disabled={pending}
                        onClick={() => run(() => removeFromGroup(group.id, [friend.id]))}
                      >
                        빼기
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold">친구 추가</h3>
                  <input className="input max-w-40 py-1" placeholder="검색" value={candidateQuery} onChange={(event) => setCandidateQuery(event.target.value)} />
                </div>
                <ul className="max-h-[24rem] divide-y divide-border/60 overflow-y-auto rounded-lg border border-border">
                  {candidates.length === 0 && (
                    <li className="p-6 text-center text-sm text-muted">
                      {friends.length === 0 ? "친구 관리에서 친구를 먼저 등록하세요." : "추가할 친구가 없습니다."}
                    </li>
                  )}
                  {candidates.slice(0, 300).map((friend) => (
                    <li key={friend.id}>
                      <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-black/[0.02]">
                        <input type="checkbox" checked={picked.has(friend.id)} onChange={() => togglePicked(friend.id)} />
                        {friend.name}
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="btn"
                    disabled={candidates.length === 0}
                    onClick={() => setPicked(new Set(candidates.map((friend) => friend.id)))}
                  >
                    검색결과 전체 선택
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary ml-auto"
                    disabled={pending || picked.size === 0}
                    onClick={() => run(() => addToGroup(group.id, [...picked]), () => setPicked(new Set()))}
                  >
                    {picked.size}명 추가
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
