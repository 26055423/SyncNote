import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Discord 式的聊天区：左边会话列表（私信 + 群），右边一整块聊天窗。
 * 会话列表里的私信来自 /api/dm/threads，群来自 /api/groups；两条通道各自收发。
 */

interface DmThread {
  peer: { id: string; nickname: string; avatar?: string };
  text: string;
  created: number;
  mine: boolean;
  unread: number;
}

interface GroupRow {
  id: string;
  name: string;
  members: number;
  unread: number;
  mentions?: number;
  avatar?: string;
  role: string;
}

interface DmMessage {
  id: number | string;
  kind?: 'text' | 'share';
  mine: boolean;
  text: string;
  ticket?: string;
  share?: number;
  created: number;
}

interface GroupMessage {
  id: number;
  person: string;
  name: string;
  kind: 'text' | 'trade' | 'recalled';
  text: string;
  ticket?: string | null;
  created: number;
  mine?: boolean;
  recallable?: boolean;
  mentions?: string[];
  share?: number | null;
}

type Active = { kind: 'dm'; id: string; name: string } | { kind: 'group'; id: string; name: string } | null;

interface Props {
  current?: { ticket: string } | null;
  onError?: (message: string) => void;
  onOpenGroupSettings?: () => void;
  onOpenFriendManager?: () => void;
}

const api = <T,>(path: string, body?: unknown): Promise<T> =>
  fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((data as { error?: string }).error ?? '请求失败');
    return data as T;
  });

function timeLabel(seconds: number) {
  const date = new Date(seconds * 1000);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toTimeString().slice(0, 5);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function ChatDock({ current, onError, onOpenGroupSettings, onOpenFriendManager }: Props) {
  const [threads, setThreads] = useState<DmThread[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [active, setActive] = useState<Active>(null);
  const [dm, setDm] = useState<DmMessage[]>([]);
  const [groupMessages, setGroupMessages] = useState<GroupMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const fail = useCallback(
    (error: unknown) => onError?.(error instanceof Error ? error.message : String(error)),
    [onError],
  );

  const loadLists = useCallback(async () => {
    try {
      const [dmData, groupData] = await Promise.all([
        api<{ threads: DmThread[] }>('/api/dm/threads'),
        api<{ groups: GroupRow[] }>('/api/groups'),
      ]);
      setThreads(dmData.threads ?? []);
      setGroups(groupData.groups ?? []);
      setActive((prev) => {
        if (prev) return prev;
        const firstDm = dmData.threads?.[0];
        const firstGroup = groupData.groups?.[0];
        if (firstDm) return { kind: 'dm', id: firstDm.peer.id, name: firstDm.peer.nickname };
        if (firstGroup) return { kind: 'group', id: firstGroup.id, name: firstGroup.name };
        return null;
      });
    } catch (error) {
      fail(error);
    }
  }, [fail]);

  const loadActive = useCallback(async () => {
    if (!active) return;
    try {
      if (active.kind === 'dm') {
        const data = await api<{ messages: DmMessage[] }>(`/api/dm?with=${encodeURIComponent(active.id)}`);
        setDm(data.messages ?? []);
      } else {
        const data = await api<{ messages: GroupMessage[] }>(`/api/groups/messages?group=${encodeURIComponent(active.id)}`);
        setGroupMessages(data.messages ?? []);
      }
    } catch (error) {
      fail(error);
    }
  }, [active, fail]);

  useEffect(() => {
    void loadLists();
    const timer = window.setInterval(() => void loadLists(), 15000);
    return () => window.clearInterval(timer);
  }, [loadLists]);

  useEffect(() => {
    void loadActive();
    const timer = window.setInterval(() => void loadActive(), 5000);
    return () => window.clearInterval(timer);
  }, [loadActive]);

  const visibleCount = useMemo(
    () => dm.length + groupMessages.length,
    [dm.length, groupMessages.length],
  );

  useEffect(() => {
    if (visibleCount) endRef.current?.scrollIntoView({ block: 'end' });
  }, [visibleCount]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !active || busy) return;
    setBusy(true);
    setDraft('');
    try {
      if (active.kind === 'dm') await api('/api/dm', { to: active.id, text });
      else await api('/api/groups/message', { group: active.id, text });
      await loadActive();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const recall = async (id: number) => {
    if (!active || active.kind !== 'group') return;
    try {
      await api('/api/groups/recall', { group: active.id, id });
      await loadActive();
    } catch (error) {
      fail(error);
    }
  };

  const shareTrade = async () => {
    if (!current?.ticket) return;
    if (!active) return;
    try {
      if (active.kind === 'group') {
        await api('/api/groups/share', { group: active.id, ticket: current.ticket });
        await loadActive();
      } else {
        await api('/api/reviews/share', { ticket: current.ticket, recipients: [active.id], message: '' });
        await loadActive();
      }
    } catch (error) {
      fail(error);
    }
  };

  const matches = (name: string) => !query.trim() || name.toLowerCase().includes(query.trim().toLowerCase());

  return (
    <div className="chat-dock">
      <div className="chat-list">
        <input
          className="chat-search"
          value={query}
          placeholder="找人 / 找群…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <p className="chat-list-title">私信</p>
        {threads.length ? (
          threads.filter((row) => matches(row.peer.nickname)).map((row) => (
            <button
              type="button"
              key={'dm-' + row.peer.id}
              className={`chat-row ${active?.kind === 'dm' && active.id === row.peer.id ? 'is-active' : ''}`}
              onClick={() => setActive({ kind: 'dm', id: row.peer.id, name: row.peer.nickname })}
            >
              <span className="chat-row-name">{row.peer.nickname}</span>
              <span className="chat-row-time">{timeLabel(row.created)}</span>
              <span className="chat-row-preview">{row.text || '（复盘分享）'}</span>
              {row.unread ? <span className="chat-row-badge">{row.unread}</span> : null}
            </button>
          ))
        ) : (
          <p className="dim chat-empty">还没有私信。到「好友」里点名字开始聊。</p>
        )}
        <p className="chat-list-title">群组 {groups.length ? `· ${groups.length}` : ''}</p>
        {groups.length ? (
          groups.filter((row) => matches(row.name)).map((row) => (
            <button
              type="button"
              key={'g-' + row.id}
              className={`chat-row ${active?.kind === 'group' && active.id === row.id ? 'is-active' : ''}`}
              onClick={() => setActive({ kind: 'group', id: row.id, name: row.name })}
            >
              <span className="chat-row-name">{row.name}</span>
              <span className="chat-row-time">{row.members} 人</span>
              {row.unread ? <span className="chat-row-badge">{row.unread}</span> : null}
              {row.mentions ? <span className="chat-row-mention">@{row.mentions}</span> : null}
            </button>
          ))
        ) : (
          <p className="dim chat-empty">还没有群。到「群组」里建一个。</p>
        )}
        <div className="chat-list-foot">
          <button type="button" className="link" onClick={onOpenFriendManager}>
            好友管理
          </button>
          <button type="button" className="link" onClick={onOpenGroupSettings}>
            群组管理
          </button>
        </div>
      </div>

      <div className="chat-main">
        {active ? (
          <>
            <div className="chat-main-head">
              <b>{active.name}</b>
              <span className="dim">{active.kind === 'dm' ? '私信' : '群聊'}</span>
              {current?.ticket ? (
                <button type="button" className="link" onClick={() => void shareTrade()}>
                  把这笔复盘（#{current.ticket}）发过去
                </button>
              ) : null}
            </div>
            <div className="chat-main-body">
              {active.kind === 'dm'
                ? dm.map((message) => (
                    <div className={`dm-bubble ${message.mine ? 'is-mine' : ''}`} key={message.id}>
                      {message.kind === 'share' ? (
                        <button
                          type="button"
                          className="dm-share"
                          onClick={() => {
                            if (message.share) location.href = `/chart?share=${message.share}`;
                          }}
                        >
                          复盘 #{message.ticket}
                        </button>
                      ) : (
                        <div className="dm-text">{message.text}</div>
                      )}
                      <small className="dim">{new Date(message.created * 1000).toLocaleTimeString()}</small>
                    </div>
                  ))
                : groupMessages.map((message) => (
                    <div className="group-message" key={message.id}>
                      <small className="dim">
                        {message.name} · {new Date(message.created * 1000).toLocaleTimeString()}
                        {message.recallable ? (
                          <button type="button" className="link" onClick={() => void recall(message.id)}>
                            撤回
                          </button>
                        ) : null}
                      </small>
                      {message.kind === 'recalled' ? (
                        <div className="dim">{message.name} 撤回了一条消息</div>
                      ) : message.kind === 'trade' ? (
                        <button
                          type="button"
                          className="group-trade"
                          onClick={() => {
                            if (message.share) location.href = `/chart?share=${message.share}`;
                          }}
                        >
                          交易 #{message.ticket} · 点开看这笔复盘
                        </button>
                      ) : (
                        <div>{message.text}</div>
                      )}
                    </div>
                  ))}
              <div ref={endRef} />
            </div>
            <div className="chat-form">
              <textarea
                value={draft}
                rows={2}
                maxLength={1000}
                placeholder={`发到 ${active.name}…（Enter 发送，Shift+Enter 换行）`}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button type="button" className="primary" onClick={() => void send()} disabled={!draft.trim() || busy}>
                发送
              </button>
            </div>
          </>
        ) : (
          <p className="dim chat-empty">左边选一个会话开始聊。</p>
        )}
      </div>
    </div>
  );
}
