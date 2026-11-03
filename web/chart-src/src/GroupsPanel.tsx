import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** 群组面板：建群 / 邀请码加入 / 群聊 / 把当前复盘发进群。 */

interface GroupRow {
  id: string;
  name: string;
  owner: string;
  code: string;
  members: number;
  role: string;
  notice?: string;
  avatar?: string;
  mentions?: number;
  unread: number;
  last?: { person: string; kind: string; text: string; created: number } | null;
}

interface GroupMember {
  id: string;
  nickname: string;
  avatar: string;
  role: string;
}

interface GroupMessage {
  id: number;
  person: string;
  name: string;
  avatar: string;
  kind: 'text' | 'trade' | 'recalled';
  text: string;
  ticket?: string | null;
  created: number;
  mentions?: string[];
  mine?: boolean;
  recallable?: boolean;
  share?: number | null;
}

interface Props {
  /** 当前正在看的复盘（有的话），用于「发到群」。 */
  current?: { ticket: string; person?: string } | null;
  onError?: (message: string) => void;
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

/** 把 @昵称 高亮成标签。 */
function renderMentions(text: string, mentions: string[]) {
  if (!text.includes('@')) return text;
  // mentions 里是被 @ 到的用户 id；这里只按文本切分做高亮，数量用于提示。
  void mentions;
  const parts = text.split(/(@[\u4e00-\u9fa5A-Za-z0-9_]+)/g);
  return parts.map((part, index) =>
    part.startsWith('@') ? (
      <mark className="group-mention" key={index}>
        {part}
      </mark>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

export function GroupsPanel({ current, onError }: Props) {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [noticeDraft, setNoticeDraft] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [showAvatars, setShowAvatars] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const fail = useCallback(
    (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      onError?.(text);
    },
    [onError],
  );

  const loadGroups = useCallback(async () => {
    try {
      const data = await api<{ groups: GroupRow[] }>('/api/groups');
      setGroups(data.groups);
      setActive((prev) => prev ?? data.groups[0]?.id ?? null);
    } catch (error) {
      fail(error);
    }
  }, [fail]);

  const loadMessages = useCallback(
    async (gid: string) => {
      try {
        const data = await api<{ messages: GroupMessage[] }>(`/api/groups/messages?group=${encodeURIComponent(gid)}`);
        setMessages(data.messages);
      } catch (error) {
        fail(error);
      }
    },
    [fail],
  );

  useEffect(() => {
    void loadGroups();
    const timer = window.setInterval(() => void loadGroups(), 15000);
    return () => window.clearInterval(timer);
  }, [loadGroups]);

  const loadMembers = useCallback(async (gid: string) => {
    try {
      const data = await api<{ members: GroupMember[] }>(`/api/groups/members?group=${encodeURIComponent(gid)}`);
      setMembers(data.members);
    } catch {
      setMembers([]);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadMembers(active);
    setShowMembers(false);
  }, [active, loadMembers]);

  useEffect(() => {
    if (!active) return;
    void loadMessages(active);
    const timer = window.setInterval(() => void loadMessages(active), 5000);
    return () => window.clearInterval(timer);
  }, [active, loadMessages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const group = useMemo(() => groups.find((row) => row.id === active) ?? null, [groups, active]);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const row = await api<GroupRow>('/api/groups/create', { name: name.trim() });
      setName('');
      await loadGroups();
      setActive(row.id);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    try {
      const row = await api<GroupRow>('/api/groups/join', { code: code.trim() });
      setCode('');
      await loadGroups();
      setActive(row.id);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !active || busy) return;
    setDraft('');
    try {
      await api('/api/groups/message', { group: active, text });
      await loadMessages(active);
    } catch (error) {
      fail(error);
    }
  };

  const shareTrade = async () => {
    if (!active || !current?.ticket || busy) return;
    setBusy(true);
    try {
      await api('/api/groups/share', { group: active, ticket: current.ticket });
      await loadMessages(active);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const openTrade = async (message: GroupMessage) => {
    if (!active) return;
    try {
      const row = await api<{ share: number }>('/api/groups/open', { group: active, id: message.id });
      location.href = `/chart?share=${row.share}`;
    } catch (error) {
      fail(error);
    }
  };

  const kick = async (id: string) => {
    if (!active) return;
    if (!window.confirm('把这个成员移出群？')) return;
    try {
      await api('/api/groups/kick', { group: active, target: id });
      await loadMembers(active);
      await loadGroups();
    } catch (error) {
      fail(error);
    }
  };

  const recall = async (id: number) => {
    if (!active) return;
    if (!window.confirm('撤回这条消息？')) return;
    try {
      await api('/api/groups/recall', { group: active, id });
      await loadMessages(active);
    } catch (error) {
      fail(error);
    }
  };

  const rename = async () => {
    if (!active || nameDraft === null) return;
    try {
      await api('/api/groups/rename', { group: active, name: nameDraft });
      setNameDraft(null);
      await loadGroups();
    } catch (error) {
      fail(error);
    }
  };

  const pickAvatar = async (avatar: string) => {
    if (!active || !group) return;
    try {
      await api('/api/groups/rename', { group: active, avatar });
      setShowAvatars(false);
      await loadGroups();
    } catch (error) {
      fail(error);
    }
  };

  const copyInvite = async () => {
    if (!group?.code) return;
    const link = `${location.origin}/chart?group=${encodeURIComponent(group.code)}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      window.prompt('复制这个邀请链接', link);
    }
  };

  const saveNotice = async () => {
    if (!active || noticeDraft === null) return;
    try {
      await api('/api/groups/notice', { group: active, notice: noticeDraft });
      setNoticeDraft(null);
      await loadGroups();
    } catch (error) {
      fail(error);
    }
  };

  const leave = async () => {
    if (!active) return;
    if (!window.confirm('退出这个群？')) return;
    try {
      await api('/api/groups/leave', { group: active });
      setActive(null);
      setMessages([]);
      await loadGroups();
    } catch (error) {
      fail(error);
    }
  };

  return (
    <div className="pane">
      <h3>
        群组 <small>{groups.length}</small>
      </h3>
      <div className="group-create">
        <input value={name} maxLength={40} placeholder="新建群（群名）" onChange={(e) => setName(e.target.value)} />
        <button type="button" onClick={() => void create()} disabled={!name.trim() || busy}>
          建群
        </button>
      </div>
      <div className="group-create">
        <input value={code} maxLength={12} placeholder="邀请码加入" onChange={(e) => setCode(e.target.value)} />
        <button type="button" onClick={() => void join()} disabled={!code.trim() || busy}>
          加入
        </button>
      </div>

      {groups.length ? (
        <div className="group-list">
          {groups.map((row) => (
            <button
              type="button"
              key={row.id}
              className={`group-row ${row.id === active ? 'is-active' : ''}`}
              onClick={() => setActive(row.id)}
            >
              <b>{row.name}</b>
              <small>
                {row.members} 人{row.role === 'owner' ? ' · 我是群主' : ''}
                {row.unread ? ` · ${row.unread} 条新消息` : ''}
                {row.mentions ? ` · ${row.mentions} 条 @你` : ''}
              </small>
            </button>
          ))}
        </div>
      ) : (
        <p className="dim">还没有群。建一个，或用别人给的邀请码加入。</p>
      )}

      {group ? (
        <div className="group-chat">
          <div className="group-head">
            {group.role === 'owner' ? (
              <button
                type="button"
                className="group-avatar-btn"
                title="换群头像"
                onClick={() => setShowAvatars((v) => !v)}
              >
                {group.avatar ? (
                  <img className="group-avatar" src={`/avatars/${group.avatar}.svg`} alt="" />
                ) : (
                  <span className="group-avatar">{group.name.slice(0, 1)}</span>
                )}
              </button>
            ) : group.avatar ? (
              <img className="group-avatar" src={`/avatars/${group.avatar}.svg`} alt="" />
            ) : (
              <span className="group-avatar">{group.name.slice(0, 1)}</span>
            )}
            {nameDraft === null ? (
              <b>{group.name}</b>
            ) : (
              <input className="group-rename" value={nameDraft} maxLength={40} onChange={(e) => setNameDraft(e.target.value)} />
            )}
            <span className="dim">{group.members} 人</span>
            {group.code ? (
              <button type="button" className="link" onClick={() => void copyInvite()} title={group.code}>
                复制邀请链接
              </button>
            ) : null}
            {group.role === 'owner' ? (
              nameDraft === null ? (
                <button type="button" className="link" onClick={() => setNameDraft(group.name)}>
                  改名
                </button>
              ) : (
                <>
                  <button type="button" className="primary" onClick={() => void rename()}>
                    保存
                  </button>
                  <button type="button" className="link" onClick={() => setNameDraft(null)}>
                    取消
                  </button>
                </>
              )
            ) : null}
            <button type="button" className="link" onClick={() => void leave()}>
              退出
            </button>
          </div>
          {showAvatars && group.role === 'owner' ? (
            <div className="group-avatar-picker">
              {Array.from({ length: 12 }, (_, index) => {
                const avatar = `avatar${index + 1}`;
                return (
                  <button
                    type="button"
                    key={avatar}
                    className={group.avatar === avatar ? 'is-active' : ''}
                    onClick={() => void pickAvatar(avatar)}
                    title={avatar}
                  >
                    <img src={`/avatars/${avatar}.svg`} alt="" />
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="group-notice">
            <b>群公告</b>
            {noticeDraft === null ? (
              <span className="dim">{group.notice || '暂无公告'}</span>
            ) : (
              <textarea
                value={noticeDraft}
                rows={2}
                maxLength={500}
                onChange={(e) => setNoticeDraft(e.target.value)}
              />
            )}
            {group.role === 'owner' ? (
              noticeDraft === null ? (
                <button type="button" className="link" onClick={() => setNoticeDraft(group.notice ?? '')}>
                  编辑
                </button>
              ) : (
                <>
                  <button type="button" className="primary" onClick={() => void saveNotice()}>
                    保存
                  </button>
                  <button type="button" className="link" onClick={() => setNoticeDraft(null)}>
                    取消
                  </button>
                </>
              )
            ) : null}
          </div>
          <button type="button" className="link group-members-toggle" onClick={() => setShowMembers((v) => !v)}>
            {showMembers ? '收起成员' : `查看成员（${group.members}）`}
          </button>
          {showMembers ? (
            <div className="group-members">
              {members.map((row) => (
                <div className="group-member" key={row.id}>
                  <span>{row.nickname}</span>
                  {row.role === 'owner' ? <small className="dim">群主</small> : null}
                  {group.role === 'owner' && row.role !== 'owner' ? (
                    <button type="button" className="link" onClick={() => void kick(row.id)}>
                      移除
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          <div className="group-messages">
            {messages.length ? (
              messages.map((message) => (
                <div className={`group-message ${message.kind === 'trade' ? 'is-trade' : ''}`} key={message.id}>
                  <small className="dim">
                    {message.name} · {new Date(message.created * 1000).toLocaleString()}
                    {message.recallable ? (
                      <button type="button" className="link" onClick={() => void recall(message.id)}>
                        撤回
                      </button>
                    ) : null}
                  </small>
                  {message.kind === 'recalled' ? (
                    <div className="dim">{message.name} 撤回了一条消息</div>
                  ) : message.kind === 'trade' ? (
                    <button type="button" className="group-trade" onClick={() => void openTrade(message)}>
                      交易 #{message.ticket} · 点开看这笔复盘
                    </button>
                  ) : (
                    <div>
                      {renderMentions(message.text, message.mentions ?? [])}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <p className="dim">还没有消息。</p>
            )}
            <div ref={endRef} />
          </div>
          <p className="chat-hint">群里能看到分享的那笔交易；完整交易列表仍然只有好友能看。</p>
          <div className="chat-form">
            <textarea
              value={draft}
              rows={2}
              maxLength={1000}
              placeholder="在群里说点什么…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button type="button" className="primary" onClick={() => void send()} disabled={!draft.trim()}>
              发送
            </button>
          </div>
          {current?.ticket ? (
            <button type="button" className="tool-btn group-share" onClick={() => void shareTrade()} disabled={busy}>
              把这笔复盘（#{current.ticket}）发到群
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
