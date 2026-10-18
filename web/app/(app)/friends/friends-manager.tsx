"use client";

import { useMemo, useState } from "react";
import { NoticeBar } from "@/components/notice-bar";
import { useAction } from "@/components/use-action";
import { addFriends, addToGroup, deleteFriends, setFriendsSenderType, updateFriend } from "@/lib/actions";
import type { Friend, Group, SenderType } from "@/lib/data";
import { parseCsvNames, parseNames } from "@/lib/message";

const PAGE_SIZE = 200;
const SENDER_LABEL: Record<SenderType, string> = { Honorific: "존댓말", TalkDown: "반말" };

/** Korean Excel saves CSV as CP949; fall back to it when UTF-8 decoding produces replacement characters. */
async function readCsv(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  return utf8.includes("�") ? new TextDecoder("euc-kr").decode(bytes) : utf8;
}

export function FriendsManager({ friends, groups }: { friends: Friend[]; groups: Group[] }) {
  const { pending, notice, setNotice, run } = useAction();

  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [singleName, setSingleName] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [newSenderType, setNewSenderType] = useState<SenderType>("Honorific");
  const [newGroupId, setNewGroupId] = useState("");

  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [senderFilter, setSenderFilter] = useState<"all" | SenderType>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);

  const groupNames = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return friends.filter((friend) => {
      if (q && !friend.name.toLowerCase().includes(q) && !friend.memo.toLowerCase().includes(q)) return false;
      if (senderFilter !== "all" && friend.senderType !== senderFilter) return false;
      if (groupFilter === "none") return friend.groupIds.length === 0;
      if (groupFilter !== "all") return friend.groupIds.includes(Number(groupFilter));
      return true;
    });
  }, [friends, query, groupFilter, senderFilter]);

  const bulkNames = useMemo(() => parseNames(bulkText), [bulkText]);
  const selectedIds = [...selected].filter((id) => friends.some((friend) => friend.id === id));
  const allFilteredSelected = filtered.length > 0 && filtered.every((friend) => selected.has(friend.id));
  const duplicateNames = friends.filter((friend) => friend.duplicateCount > 1).length;

  const toggle = (id: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected(allFilteredSelected ? new Set() : new Set(filtered.map((friend) => friend.id)));

  const submitAdd = () => {
    const names = mode === "single" ? [singleName] : bulkNames;
    run(
      () => addFriends(names, newSenderType, newGroupId ? Number(newGroupId) : undefined),
      () => {
        setSingleName("");
        setBulkText("");
      },
    );
  };

  const importCsv = async (file: File | undefined) => {
    if (!file) return;
    const names = parseCsvNames(await readCsv(file));
    setMode("bulk");
    setBulkText(names.join("\n"));
    setNotice({ tone: "ok", text: `${file.name}에서 ${names.length}명을 읽었습니다. 확인 후 "추가"를 누르세요.` });
  };

  const saveName = () => {
    if (!editing) return;
    const { id, name } = editing;
    run(() => updateFriend(id, { name }), () => setEditing(null));
  };

  return (
    <div className="space-y-5">
      <NoticeBar notice={notice} onClose={() => setNotice(null)} />

      <section className="card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex rounded-lg bg-black/[0.04] p-1 text-sm">
            {(["single", "bulk"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={`rounded-md px-3 py-1.5 font-medium ${mode === value ? "bg-surface shadow-sm" : "text-muted"}`}
              >
                {value === "single" ? "한 명씩" : "여러 명 붙여넣기"}
              </button>
            ))}
          </div>
          <label className="btn cursor-pointer">
            CSV 불러오기
            <input
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="sr-only"
              onChange={(event) => {
                importCsv(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </label>
        </div>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submitAdd();
          }}
        >
          {mode === "single" ? (
            <input
              className="input"
              placeholder="카카오톡 친구 이름 (예: 홍길동)"
              value={singleName}
              onChange={(event) => setSingleName(event.target.value)}
              maxLength={50}
            />
          ) : (
            <div>
              <textarea
                className="input min-h-32 font-mono"
                placeholder={"한 줄에 한 명씩, 또는 쉼표로 구분\n홍길동\n김철수, 이영희"}
                value={bulkText}
                onChange={(event) => setBulkText(event.target.value)}
              />
              <p className="mt-1 text-xs text-muted">{bulkNames.length}명 인식됨</p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <select className="input w-auto" value={newSenderType} onChange={(event) => setNewSenderType(event.target.value as SenderType)}>
              <option value="Honorific">존댓말로 보내기</option>
              <option value="TalkDown">반말로 보내기</option>
            </select>
            <select className="input w-auto" value={newGroupId} onChange={(event) => setNewGroupId(event.target.value)}>
              <option value="">그룹 없이 추가</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name} 그룹에 추가
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={pending || (mode === "single" ? !singleName.trim() : bulkNames.length === 0)}
            >
              추가
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
          <input
            className="input max-w-xs"
            placeholder="이름·메모 검색"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setVisible(PAGE_SIZE);
            }}
          />
          <select className="input w-auto" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
            <option value="all">모든 그룹</option>
            <option value="none">그룹 없음</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
          <select
            className="input w-auto"
            value={senderFilter}
            onChange={(event) => setSenderFilter(event.target.value as "all" | SenderType)}
          >
            <option value="all">모든 말투</option>
            <option value="Honorific">존댓말</option>
            <option value="TalkDown">반말</option>
          </select>
          <span className="ml-auto text-sm text-muted">
            {filtered.length} / {friends.length}명
            {duplicateNames > 0 && <span className="ml-2 text-amber-700">동명이인 {duplicateNames}명</span>}
          </span>
        </div>

        {selectedIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-black/[0.02] px-4 py-3 text-sm">
            <span className="font-medium">{selectedIds.length}명 선택</span>
            <button type="button" className="btn" disabled={pending} onClick={() => run(() => setFriendsSenderType(selectedIds, "Honorific"))}>
              존댓말로
            </button>
            <button type="button" className="btn" disabled={pending} onClick={() => run(() => setFriendsSenderType(selectedIds, "TalkDown"))}>
              반말로
            </button>
            {groups.length > 0 && (
              <select
                className="input w-auto"
                value=""
                disabled={pending}
                onChange={(event) => {
                  const groupId = Number(event.target.value);
                  if (groupId) run(() => addToGroup(groupId, selectedIds));
                }}
              >
                <option value="">그룹에 넣기…</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="btn btn-danger ml-auto"
              disabled={pending}
              onClick={() => {
                if (confirm(`${selectedIds.length}명을 삭제할까요? 그룹에서도 빠집니다.`)) {
                  run(() => deleteFriends(selectedIds), () => setSelected(new Set()));
                }
              }}
            >
              삭제
            </button>
          </div>
        )}

        {friends.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted">아직 등록한 친구가 없습니다. 위에서 이름을 추가하거나 CSV를 불러오세요.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-border">
                  <th className="w-10 px-4 py-2">
                    <input type="checkbox" checked={allFilteredSelected} onChange={toggleAll} aria-label="전체 선택" />
                  </th>
                  <th className="px-2 py-2">이름</th>
                  <th className="px-2 py-2">말투</th>
                  <th className="px-2 py-2">그룹</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, visible).map((friend) => (
                  <tr key={friend.id} className="border-b border-border/60 last:border-0 hover:bg-black/[0.015]">
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(friend.id)}
                        onChange={() => toggle(friend.id)}
                        aria-label={`${friend.name} 선택`}
                      />
                    </td>
                    <td className="px-2 py-2">
                      {editing?.id === friend.id ? (
                        <form
                          className="flex gap-1"
                          onSubmit={(event) => {
                            event.preventDefault();
                            saveName();
                          }}
                        >
                          <input
                            className="input py-1"
                            value={editing.name}
                            autoFocus
                            maxLength={50}
                            onChange={(event) => setEditing({ id: friend.id, name: event.target.value })}
                            onKeyDown={(event) => event.key === "Escape" && setEditing(null)}
                          />
                          <button type="submit" className="btn py-1" disabled={pending}>
                            저장
                          </button>
                        </form>
                      ) : (
                        <button
                          type="button"
                          className="text-left hover:underline"
                          title="눌러서 이름 수정"
                          onClick={() => setEditing({ id: friend.id, name: friend.name })}
                        >
                          {friend.name}
                          {friend.duplicateCount > 1 && (
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
                              동명이인 {friend.duplicateCount}
                            </span>
                          )}
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(() => updateFriend(friend.id, { senderType: friend.senderType === "Honorific" ? "TalkDown" : "Honorific" }))
                        }
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          friend.senderType === "Honorific" ? "bg-blue-50 text-blue-700" : "bg-orange-50 text-orange-700"
                        }`}
                        title="눌러서 말투 바꾸기"
                      >
                        {SENDER_LABEL[friend.senderType]}
                      </button>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap gap-1">
                        {friend.groupIds.map((groupId) => (
                          <span key={groupId} className="rounded bg-black/[0.05] px-1.5 py-0.5 text-xs">
                            {groupNames.get(groupId)}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > visible && (
              <div className="p-4 text-center">
                <button type="button" className="btn" onClick={() => setVisible((count) => count + PAGE_SIZE)}>
                  {filtered.length - visible}명 더 보기
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
