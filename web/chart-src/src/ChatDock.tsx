import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, stamp } from './api';
import { usePrefs } from './ui/prefs';
import { GroupEntry } from './GroupEntry';
import { GroupDetails } from './GroupDetails';

interface Person { id: string; nickname: string; avatar?: string; username?: string; bio?: string; online?: boolean; role?: string; can_chat?: boolean }
interface DmThread { peer: Person; text: string; created: number; unread: number }
interface GroupRow {
  id: string; name: string; members: number; unread: number; mentions?: number;
  avatar?: string; notice?: string; code?: string; role: string; last?: { text: string; created: number } | null;
}
interface Reaction { emoji: string; count: number; mine: boolean }
interface Message {
  id: number | string; person?: string; name?: string; avatar?: string;
  kind?: 'text' | 'share' | 'trade' | 'recalled'; mine: boolean; text: string;
  ticket?: string; share?: number; created: number; read?: boolean; recallable?: boolean;
  mentions?: string[]; reply?: { id: number; name: string; text: string } | null; reactions?: Reaction[];
}
type Conversation = { kind: 'dm' | 'group'; id: string; name: string; avatar?: string };
interface Props {
  visible?: boolean;
  current?: { ticket: string } | null;
  onShareCurrent?: (destination: { kind: 'dm' | 'group'; id: string }) => void;
  onError?: (message: string) => void;
  openGroup?: { id: string; name: string; avatar?: string } | null;
  onGroupOpened?: () => void;
  onOpenFriendManager?: () => void;
}
const EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '✅'];
const keyOf = (row: Conversation) => `${row.kind}:${row.id}`;

function Icon({ name }: { name: 'search' | 'expand' | 'collapse' | 'profile' | 'reply' | 'smile' | 'send' | 'chart' | 'back' | 'close' | 'users' }) {
  const paths = {
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
    expand: <path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6" />,
    collapse: <path d="M3 9h6V3m6 0v6h6M9 21v-6H3m18 0h-6v6" />,
    profile: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
    reply: <path d="m10 5-7 6 7 6v-4c6 0 9 2 11 6 0-9-4-12-11-12Z" />,
    smile: <><circle cx="12" cy="12" r="9" /><path d="M8 14c2 3 6 3 8 0M8 8h.01M16 8h.01" /></>,
    send: <path d="m3 3 19 9-19 9 4-9Zm4 9h15" />,
    chart: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m6 15 4-5 4 3 4-6" /></>,
    back: <path d="m14 5-7 7 7 7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    users: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5" /></>,
  };
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function Avatar({ name, avatar, size = '' }: { name: string; avatar?: string; size?: string }) {
  const src = avatar && /^avatar(?:[1-9]|1[0-2])$/.test(avatar) ? `/avatars/${avatar}.svg` : undefined;
  return <span className={`dc-avatar ${size}`} aria-hidden="true">{src ? <img src={src} alt="" /> : name.slice(0, 2)}</span>;
}

/** 私信与群聊共用会话、引用回复、表情回应和复盘卡片。 */
export function ChatDock({ visible = true, current, onShareCurrent, onError, openGroup, onGroupOpened, onOpenFriendManager }: Props) {
  const prefs = usePrefs();
  const [threads, setThreads] = useState<DmThread[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [friends, setFriends] = useState<Person[]>([]);
  const [me, setMe] = useState<Person | null>(null);
  const [requests, setRequests] = useState(0);
  const [active, setActive] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<Person[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replies, setReplies] = useState<Record<string, Message | null>>({});
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'dm' | 'group' | 'unread'>('dm');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState(false);
  const [groupEntry, setGroupEntry] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  /** 触屏长按显示消息操作（桌面仍是 hover 显示）。 */
  const [actionFor, setActionFor] = useState<string | number | null>(null);
  const pressTimer = useRef<number | null>(null);
  const [reactionPicker, setReactionPicker] = useState<number | string | null>(null);
  const [jumpTarget, setJumpTarget] = useState<number | string | null>(null);
  const [pendingNew, setPendingNew] = useState(false);
  const activeRef = useRef<Conversation | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const selectionRef = useRef({ start: 0, end: 0 });
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const nearBottom = useRef(true);
  const renderedKey = useRef('');
  const lastMessage = useRef('');
  const mounted = useRef(true);
  const listVersion = useRef(0);
  const pendingReads = useRef(new Map<string, Promise<void>>());
  const reactionBusy = useRef(false);
  const writeBusy = useRef(false);
  const activeKey = active ? keyOf(active) : '';
  const draft = drafts[activeKey] ?? '';
  const reply = replies[activeKey] ?? null;
  const fail = useCallback((error: unknown) => onError?.(error instanceof Error ? error.message : String(error)), [onError]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const select = (row: Conversation) => {
    activeRef.current = row; setActive(row); setMessages([]); setMembers([]);
    setSearch(''); setEmojiOpen(false); setReactionPicker(null); setPendingNew(false); nearBottom.current = true;
  };
  const loadLists = useCallback(async () => {
    if (!visibleRef.current || document.hidden) return;
    const version = ++listVersion.current;
    try {
      const [dmData, groupData, profile] = await Promise.all([
        api<{ threads: DmThread[] }>('/api/dm/threads'), api<{ groups: GroupRow[] }>('/api/groups'),
        api<{ user: Person; friends: Person[]; incoming: unknown[] }>('/api/profile'),
      ]);
      if (!mounted.current || !visibleRef.current || version !== listVersion.current) return;
      const people = (profile.friends ?? []).filter((person) => person.can_chat !== false);
      setThreads(dmData.threads.filter((row) => people.some((person) => person.id === row.peer.id)));
      setGroups(groupData.groups ?? []); setFriends(people); setMe(profile.user); setRequests(profile.incoming?.length ?? 0);
      const selected = activeRef.current;
      if (selected && !(selected.kind === 'dm' ? people : groupData.groups).some((row) => row.id === selected.id)) {
        activeRef.current = null; setActive(null); setMessages([]); setMembers([]);
      }
    } catch (error) { if (mounted.current) fail(error); }
  }, [fail]);
  useEffect(() => {
    if (!visible || !openGroup) return;
    setFilter('group');
    select({ kind: 'group', ...openGroup });
    void loadLists();
    onGroupOpened?.();
  }, [visible, openGroup, onGroupOpened, loadLists]);
  const loadConversation = useCallback(async (conversation: Conversation, fresh = false): Promise<void> => {
    const key = keyOf(conversation);
    const readable = () => mounted.current && visibleRef.current && !document.hidden && activeRef.current && keyOf(activeRef.current) === key;
    if (!readable()) return;
    const pending = pendingReads.current.get(key);
    if (pending) {
      await pending;
      if (fresh) await loadConversation(conversation);
      return;
    }
    const request = (async () => { try {
      const result = await api<{ messages: Message[] }>(conversation.kind === 'dm'
        ? `/api/dm?with=${encodeURIComponent(conversation.id)}`
        : `/api/groups/messages?group=${encodeURIComponent(conversation.id)}`);
      if (!readable()) return;
      setMessages(result.messages ?? []);
      if (conversation.kind === 'dm') setThreads((rows) => rows.map((row) => row.peer.id === conversation.id ? { ...row, unread: 0 } : row));
      else setGroups((rows) => rows.map((row) => row.id === conversation.id ? { ...row, unread: 0, mentions: 0 } : row));
    } catch (error) { if (readable()) fail(error); }
    finally { if (readable()) setLoading(false); } })();
    pendingReads.current.set(key, request);
    try { await request; }
    finally { if (pendingReads.current.get(key) === request) pendingReads.current.delete(key); }
  }, [fail]);
  useEffect(() => {
    if (!visible) return;
    void loadLists();
    const timer = window.setInterval(() => { if (!document.hidden) void loadLists(); }, 15000);
    return () => window.clearInterval(timer);
  }, [visible, loadLists]);
  useEffect(() => {
    if (!visible || !active) return;
    setLoading(true); void loadConversation(active);
    const refresh = () => { if (!document.hidden) void loadConversation(active); };
    const timer = window.setInterval(refresh, 4000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [visible, active, loadConversation]);
  useEffect(() => {
    if (!visible || active?.kind !== 'group') return;
    let alive = true;
    const load = () => api<{ members: Person[] }>(`/api/groups/members?group=${encodeURIComponent(active.id)}`)
      .then((data) => { if (alive) setMembers(data.members); }).catch((error) => { if (alive) fail(error); });
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [visible, active, fail]);
  useEffect(() => {
    const latest = messages.at(-1);
    const last = latest ? `${latest.id}:${latest.created}` : '';
    if (renderedKey.current !== activeKey || last !== lastMessage.current) {
      if (nearBottom.current || renderedKey.current !== activeKey) {
        const box = timelineRef.current; if (box) box.scrollTop = box.scrollHeight; setPendingNew(false);
      } else if (last) setPendingNew(true);
    }
    renderedKey.current = activeKey; lastMessage.current = last;
  }, [messages, activeKey, visible, expanded, details]);
  useEffect(() => {
    if (!visible) { setEmojiOpen(false); setReactionPicker(null); }
  }, [visible]);
  useEffect(() => {
    const box = timelineRef.current;
    if (!visible || !box) return;
    const resize = new ResizeObserver(() => { if (nearBottom.current) box.scrollTop = box.scrollHeight; });
    resize.observe(box);
    return () => resize.disconnect();
  }, [visible, activeKey]);
  useEffect(() => {
    if (!visible || (!emojiOpen && reactionPicker == null)) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.dc-emoji-picker, .dc-message-reaction-picker, [data-emoji-trigger]')) { setEmojiOpen(false); setReactionPicker(null); }
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [visible, emojiOpen, reactionPicker]);
  useEffect(() => {
    if (jumpTarget == null) return;
    const row = document.getElementById(`dc-message-${activeKey}-${jumpTarget}`);
    if (row) { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); row.focus({ preventScroll: true }); }
    else fail(new Error('原消息不在当前加载的记录中'));
    setJumpTarget(null);
  }, [jumpTarget, activeKey, fail]);
  const setDraft = (value: string) => setDrafts((all) => ({ ...all, [activeKey]: value.slice(0, 1000) }));
  useLayoutEffect(() => {
    const input = composerRef.current;
    if (!visible || !input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 150) + 'px';
  }, [draft, visible, activeKey]);
  const insertText = (text: string) => {
    const { start, end } = selectionRef.current;
    const insertion = text.slice(0, Math.max(0, 1000 - draft.length + end - start));
    setDraft(draft.slice(0, start) + insertion + draft.slice(end));
    const cursor = start + insertion.length;
    selectionRef.current = { start: cursor, end: cursor };
    setEmojiOpen(false);
    window.requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(cursor, cursor); });
  };
  const enterGroup = async (row: GroupRow) => {
    setGroups((all) => [row, ...all.filter((item) => item.id !== row.id)]);
    setFilter('group'); setQuery(''); setDetails(true); setGroupEntry(false);
    select({ kind: 'group', id: row.id, name: row.name, avatar: row.avatar });
    await loadLists();
  };
  const refreshGroup = async (id: string) => {
    await loadLists();
    if (!visibleRef.current || activeRef.current?.kind !== 'group' || activeRef.current.id !== id) return;
    const result = await api<{ members: Person[] }>(`/api/groups/members?group=${encodeURIComponent(id)}`);
    if (mounted.current && activeRef.current?.kind === 'group' && activeRef.current.id === id) setMembers(result.members);
  };
  const send = async () => {
    const conversation = activeRef.current;
    const text = draft.trim();
    if (!conversation || !text || writeBusy.current) return;
    const key = keyOf(conversation); writeBusy.current = true; setBusy(true);
    try {
      await api(conversation.kind === 'dm' ? '/api/dm' : '/api/groups/message', {
        ...(conversation.kind === 'dm' ? { to: conversation.id } : { group: conversation.id }),
        text, ...(reply ? { reply_to: reply.id } : {}),
      });
      if (!mounted.current) return;
      setDrafts((all) => ({ ...all, [key]: all[key] === draft ? '' : all[key] }));
      setReplies((all) => ({ ...all, [key]: all[key]?.id === reply?.id ? null : all[key] }));
      if (activeRef.current && keyOf(activeRef.current) === key) nearBottom.current = true;
      await loadConversation(conversation, true); await loadLists();
    } catch (error) { fail(error); }
    finally { writeBusy.current = false; if (mounted.current) setBusy(false); }
  };
  const react = async (message: Message, emoji: string) => {
    const conversation = activeRef.current;
    if (!conversation || reactionBusy.current) return;
    reactionBusy.current = true;
    try {
      await api(conversation.kind === 'dm' ? '/api/dm/reaction' : '/api/groups/reaction', {
        ...(conversation.kind === 'dm' ? { to: conversation.id } : { group: conversation.id }), id: message.id, emoji,
        active: !message.reactions?.some((item) => item.emoji === emoji && item.mine),
      });
      setReactionPicker(null); await loadConversation(conversation, true);
    } catch (error) { fail(error); }
    finally { reactionBusy.current = false; }
  };
  const recall = async (message: Message) => {
    const conversation = activeRef.current;
    if (!conversation || conversation.kind !== 'group') return;
    try { await api('/api/groups/recall', { group: conversation.id, id: message.id }); await loadConversation(conversation, true); }
    catch (error) { fail(error); }
  };
  const openGroupTrade = async (message: Message) => {
    const conversation = activeRef.current;
    if (!conversation || conversation.kind !== 'group') return;
    // 在点击手势内开新页；原交易台的本机 EA 连接保持运行。
    const reviewTab = window.open('about:blank', '_blank');
    if (!reviewTab) { fail(new Error('请允许打开复盘的新标签页')); return; }
    reviewTab.opener = null;
    if (message.mine) { reviewTab.location.replace(`/chart?ticket=${encodeURIComponent(message.ticket ?? '')}`); return; }
    try {
      const result = await api<{ share: number }>('/api/groups/open', { group: conversation.id, id: message.id });
      reviewTab.location.replace(`/chart?share=${result.share}`);
    } catch (error) { reviewTab.close(); fail(error); }
  };
  const dmRows = useMemo(() => {
    const rows = [...threads];
    for (const person of friends) if (!rows.some((row) => row.peer.id === person.id)) rows.push({ peer: person, text: '开始一段对话', created: 0, unread: 0 });
    return rows;
  }, [threads, friends]);
  const match = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase());
  const visibleDm = dmRows.filter((row) => match(row.peer.nickname) && (filter !== 'unread' || row.unread > 0));
  const visibleGroups = groups.filter((row) => match(row.name) && (filter !== 'unread' || row.unread > 0));
  const visibleMessages = messages.filter((row) => !search.trim() || `${row.text} ${row.name ?? ''} ${row.ticket ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const group = groups.find((row) => active?.kind === 'group' && row.id === active.id);
  const peer = dmRows.find((row) => active?.kind === 'dm' && row.peer.id === active.id)?.peer;
  const person = friends.find((row) => row.id === peer?.id) ?? peer;
  const unread = threads.reduce((sum, row) => sum + row.unread, 0) + groups.reduce((sum, row) => sum + row.unread, 0);
  const name = active?.kind === 'group' ? group?.name ?? active.name : person?.nickname ?? active?.name ?? '';
  // 订阅显示时区，与图表和其他时间显示同步重绘。
  void prefs.timezone;

  return (
    <section className={`dc-shell ${active ? 'has-active' : ''} ${expanded ? 'is-expanded' : ''} ${details ? 'show-details' : ''}`} aria-label="同频聊天"
      onKeyDown={(event) => { if (event.key === 'Escape') { if (reactionPicker != null) setReactionPicker(null); else if (emojiOpen) setEmojiOpen(false); else if (reply) setReplies((all) => ({ ...all, [activeKey]: null })); else if (details) setDetails(false); else setExpanded(false); } }}>
      <aside className="dc-sidebar" aria-label="会话列表">
        {expanded && <button type="button" className="dc-sidebar-close" onClick={() => setExpanded(false)}><Icon name="collapse" />收起聊天</button>}
        <div className="dc-search"><Icon name="search" /><input aria-label="搜索好友或群组" placeholder="寻找或开始一段对话" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <nav className="dc-nav" aria-label="聊天分类">
          <button type="button" className={filter === 'dm' ? 'is-active' : ''} onClick={() => setFilter('dm')}><Icon name="profile" />私信</button>
          <button type="button" className={filter === 'group' ? 'is-active' : ''} onClick={() => setFilter('group')}><Icon name="users" />群聊</button>
          <button type="button" className={filter === 'unread' ? 'is-active' : ''} onClick={() => setFilter('unread')}>未读{unread ? <span className="dc-badge">{unread}</span> : null}</button>
        </nav>
        <div className="dc-conversations">
          {filter !== 'group' && <><div className="dc-section-title">私信 <button type="button" title="添加好友" aria-label="添加好友" onClick={onOpenFriendManager}>+</button></div>
            {visibleDm.map((row) => <button type="button" key={row.peer.id} aria-current={active?.kind === 'dm' && active.id === row.peer.id ? 'true' : undefined}
              className={`dc-conversation ${active?.kind === 'dm' && active.id === row.peer.id ? 'is-active' : ''}`}
              onClick={() => select({ kind: 'dm', id: row.peer.id, name: row.peer.nickname, avatar: row.peer.avatar })}>
              <span className="dc-avatar-wrap"><Avatar name={row.peer.nickname} avatar={row.peer.avatar} />{row.peer.online ? <i className="dc-presence is-online" aria-label="在线" /> : null}</span>
              <span className="dc-conversation-copy"><span className="dc-conversation-name">{row.peer.nickname}</span><span className="dc-preview">{row.text || '复盘分享'}</span></span>
              {row.unread > 0 && <span className="dc-badge" aria-label={`${row.unread} 条未读`}>{row.unread}</span>}
            </button>)}
            {!visibleDm.length && <p className="dc-empty">{filter === 'unread' ? '私信已全部读完' : query ? '没有找到这位好友' : '添加交易伙伴，开始交流。'}</p>}</>}
          {filter !== 'dm' && <><div className="dc-section-title">群聊 <button type="button" title="创建或加入群聊" aria-label="创建或加入群聊" onClick={() => setGroupEntry(true)}>+</button></div>
            {visibleGroups.map((row) => <button type="button" key={row.id} className={`dc-conversation ${active?.kind === 'group' && active.id === row.id ? 'is-active' : ''}`}
              aria-current={active?.kind === 'group' && active.id === row.id ? 'true' : undefined} onClick={() => select({ kind: 'group', id: row.id, name: row.name, avatar: row.avatar })}>
              <Avatar name={row.name} avatar={row.avatar} /><span className="dc-conversation-copy"><span className="dc-conversation-name">{row.name}</span><span className="dc-preview">{row.mentions ? `有人 @ 你 · ${row.mentions} 条` : row.last?.text || `${row.members} 位成员`}</span></span>
              {row.unread > 0 && <span className="dc-badge">{row.unread}</span>}
            </button>)}
            {!visibleGroups.length && <p className="dc-empty">{filter === 'unread' ? '群聊已全部读完' : query ? '没有找到这个群聊' : '创建或加入群组，一起讨论交易。'}</p>}</>}
        </div>
        <div className="dc-sidebar-foot"><button type="button" onClick={onOpenFriendManager}>好友管理{requests ? ` · ${requests} 个申请` : ''}</button><button type="button" onClick={() => setGroupEntry(true)}>创建 / 加入群</button></div>
        <a className="dc-self" href="/profile" target="_blank" rel="noopener noreferrer"><Avatar name={me?.nickname ?? '我'} avatar={me?.avatar} size="sm" /><span><b>{me?.nickname ?? '我的账户'}</b><small>个人资料与设置 ↗</small></span></a>
      </aside>
      <div className="dc-content">
        <header className="dc-header">
          <button type="button" className="dc-icon-button dc-mobile-back" aria-label="返回会话列表" onClick={() => { activeRef.current = null; setActive(null); }}><Icon name="back" /></button>
          <div className="dc-header-title">{active ? <Avatar name={name} avatar={group?.avatar ?? active.avatar} size="sm" /> : <Icon name="users" />}<b>{name || '同频 · 聊天'}</b><small>{active?.kind === 'group' ? `${group?.members ?? 0} 位成员` : active ? (peer?.online ? '在线' : '私信') : '与交易伙伴保持同频'}</small></div>
          <div className="dc-header-tools">
            {active && <label className="dc-message-search"><Icon name="search" /><input aria-label="搜索已加载消息" placeholder="搜索最近消息" value={search} onChange={(event) => setSearch(event.target.value)} /></label>}
            {active && <button type="button" className="dc-icon-button" title={active.kind === 'dm' ? '查看资料' : '查看成员'} aria-label={active.kind === 'dm' ? '查看资料' : '查看成员'} aria-pressed={details} onClick={() => setDetails((value) => !value)}><Icon name={active.kind === 'dm' ? 'profile' : 'users'} /></button>}
            <button type="button" className="dc-icon-button" title={expanded ? '收起聊天' : '展开聊天'} aria-label={expanded ? '收起聊天' : '展开聊天'} aria-pressed={expanded} onClick={() => setExpanded((value) => !value)}><Icon name={expanded ? 'collapse' : 'expand'} /></button>
          </div>
        </header>
        {active ? <>
          <div className="dc-timeline" ref={timelineRef} role="log" aria-label={`${name} 的消息`} aria-busy={loading} onScroll={() => {
            const box = timelineRef.current; if (!box) return;
            nearBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
            if (nearBottom.current) setPendingNew(false);
          }}>
            <div className="dc-intro"><Avatar name={name} avatar={group?.avatar ?? active.avatar} size="lg" /><h2>{active.kind === 'group' ? '# ' : ''}{name}</h2><p>{active.kind === 'group' ? group?.notice || '交流思路，分享复盘，一起把交易做得更好。' : `这是你与 ${name} 的私信。分享想法，也分享每一次交易的成长。`}</p></div>
            {loading && !messages.length && <p className="dc-empty" role="status">正在加载消息…</p>}
            {!loading && !visibleMessages.length && <p className="dc-empty">{search ? '没有找到匹配的消息' : '对话从这里开始，打个招呼吧。'}</p>}
            {visibleMessages.map((message, index) => {
              const prev = visibleMessages[index - 1];
              const author = message.mine ? me?.nickname ?? '我' : message.name ?? name;
              const avatar = message.mine ? me?.avatar : message.avatar ?? peer?.avatar;
              const day = stamp(message.created).slice(0, 10);
              const grouped = prev && day === stamp(prev.created).slice(0, 10) && (prev.person || String(prev.mine)) === (message.person || String(message.mine)) && message.created - prev.created < 300 && !message.reply;
              const interactive = message.kind !== 'recalled' && typeof message.id === 'number';
              return <Fragment key={message.id}>
                {(!prev || day !== stamp(prev.created).slice(0, 10)) && <div className="dc-date-divider"><span>{day}</span></div>}
                <article
                  tabIndex={-1}
                  id={`dc-message-${activeKey}-${message.id}`}
                  className={`dc-message ${grouped ? 'is-grouped' : ''} ${me && message.mentions?.includes(me.id) ? 'is-mentioned' : ''} ${actionFor === message.id ? 'is-actions-open' : ''}`}
                  onTouchStart={() => {
                    if (pressTimer.current) window.clearTimeout(pressTimer.current);
                    pressTimer.current = window.setTimeout(() => setActionFor(message.id), 450);
                  }}
                  onTouchEnd={() => {
                    if (pressTimer.current) { window.clearTimeout(pressTimer.current); pressTimer.current = null; }
                  }}
                  onTouchMove={() => {
                    if (pressTimer.current) { window.clearTimeout(pressTimer.current); pressTimer.current = null; }
                  }}
                  onContextMenu={(event) => {
                    if (window.matchMedia('(hover: none)').matches) { event.preventDefault(); setActionFor(message.id); }
                  }}
                  onClick={(event) => {
                    // 点消息本身（不是操作按钮）时收起长按菜单。
                    if (!actionFor) return;
                    if ((event.target as HTMLElement).closest('.dc-message-actions')) return;
                    setActionFor(null);
                  }}
                >
                  <div className="dc-message-avatar">{!grouped && <Avatar name={author} avatar={avatar} />}</div>
                  <div className="dc-message-content">
                    {message.reply && <button type="button" className="dc-reply-preview" onClick={() => { setSearch(''); setJumpTarget(message.reply!.id); }} title="跳转到原消息"><Icon name="reply" /><b>{message.reply.name}</b><span>{message.reply.text || '复盘分享'}</span></button>}
                    {!grouped && <div className="dc-message-meta"><strong>{author}</strong>{message.mine && <small>我</small>}<time dateTime={new Date(message.created * 1000).toISOString()} title={stamp(message.created)}>{stamp(message.created).slice(11, 16)}</time></div>}
                    {message.kind === 'recalled' ? <p className="dc-message-text dim">{author} 撤回了一条消息</p> : <>
                      {message.kind === 'share' && <a className="dc-share-card" href={`/chart?share=${message.share}`} target="_blank" rel="noopener noreferrer"><Icon name="chart" /><span><small>交易复盘</small><b>#{message.ticket}</b><span>查看图表与复盘 ↗</span></span></a>}
                      {message.kind === 'trade' && <button type="button" className="dc-share-card" onClick={() => void openGroupTrade(message)}><Icon name="chart" /><span><small>交易复盘</small><b>#{message.ticket}</b><span>查看图表与复盘 ↗</span></span></button>}
                      {message.text && <p className="dc-message-text">{message.text}</p>}
                      {!!message.reactions?.length && <div className="dc-reactions" aria-label="表情回应">{message.reactions.map((item) => <button type="button" key={item.emoji} className={`dc-reaction ${item.mine ? 'is-mine' : ''}`} aria-label={`${item.emoji}，${item.count} 人回应`} aria-pressed={item.mine} onClick={() => void react(message, item.emoji)}>{item.emoji} <span>{item.count}</span></button>)}</div>}
                    </>}
                  </div>
                  {interactive && <div className="dc-message-actions" aria-label="消息操作">
                    {EMOJI.slice(0, 3).map((emoji) => <button type="button" className="dc-icon-button" key={emoji} aria-label={`回应 ${emoji}`} title={`回应 ${emoji}`} onClick={() => void react(message, emoji)}>{emoji}</button>)}
                    <button type="button" className="dc-icon-button" data-emoji-trigger aria-label="更多表情回应" title="更多表情回应" aria-expanded={reactionPicker === message.id} onClick={() => { setEmojiOpen(false); setReactionPicker((value) => value === message.id ? null : message.id); }}><Icon name="smile" /></button>
                    <button type="button" className="dc-icon-button" aria-label={`回复 ${author}`} title="引用回复" onClick={() => { setReplies((all) => ({ ...all, [activeKey]: message })); composerRef.current?.focus(); }}><Icon name="reply" /></button>
                    {message.recallable && <button type="button" className="dc-icon-button" aria-label="撤回消息" title="撤回消息" onClick={() => void recall(message)}><Icon name="close" /></button>}
                  </div>}
                  {interactive && reactionPicker === message.id && <div className="dc-message-reaction-picker" role="group" aria-label="选择表情回应">{EMOJI.map((emoji) => <button type="button" className="dc-icon-button" key={emoji} aria-label={`添加回应 ${emoji}`} onClick={() => void react(message, emoji)}>{emoji}</button>)}</div>}
                </article>
              </Fragment>;
            })}
          </div>
          <div className="dc-composer-wrap">
            {pendingNew && <button type="button" className="dc-new-messages" onClick={() => { const box = timelineRef.current; if (box) box.scrollTop = box.scrollHeight; setPendingNew(false); nearBottom.current = true; }}>有新消息 · 回到底部 ↓</button>}
            {reply && <div className="dc-reply-bar"><Icon name="reply" /><span>回复 <b>{reply.mine ? me?.nickname : reply.name ?? name}</b>：{reply.text || '复盘分享'}</span><button type="button" className="dc-icon-button" aria-label="取消回复" onClick={() => setReplies((all) => ({ ...all, [activeKey]: null }))}><Icon name="close" /></button></div>}
            {emojiOpen && <div className="dc-emoji-picker" role="group" aria-label="插入表情">{[...EMOJI, '🙌', '🤝', '📈', '📉', '💡', '🔥'].map((emoji) => <button type="button" key={emoji} aria-label={`插入 ${emoji}`} onClick={() => insertText(emoji)}>{emoji}</button>)}</div>}
            <div className="dc-composer">
              {current && onShareCurrent && <button type="button" className="dc-icon-button" title={`选择好友或群聊，分享复盘 #${current.ticket}`} aria-label="分享当前复盘" disabled={busy} onClick={() => onShareCurrent({ kind: active.kind, id: active.id })}><Icon name="chart" /></button>}
              <textarea ref={composerRef} aria-label={`发消息给 ${name}`} value={draft} rows={1} maxLength={1000} placeholder={active.kind === 'dm' ? `发消息给 @${name}` : `发送到 # ${name}`} onSelect={(event) => { selectionRef.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }; }} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
              }} />
              <div className="dc-composer-tools"><button type="button" className="dc-icon-button" data-emoji-trigger aria-label="插入表情" title="表情" aria-expanded={emojiOpen} onClick={() => { setReactionPicker(null); setEmojiOpen((value) => !value); }}><Icon name="smile" /></button><button type="button" className="dc-icon-button" aria-label="发送消息" title="发送消息" disabled={!draft.trim() || busy} onClick={() => void send()}><Icon name="send" /></button></div>
            </div>
            <div className="dc-composer-hint"><span>{busy ? '正在发送…' : 'Enter 发送 · Shift+Enter 换行'}</span><span>{draft.length}/1000</span></div>
          </div>
        </> : <div className="dc-empty dc-welcome"><Icon name="users" /><h2>每一次交流，都让交易更进一步</h2><p>从左侧选择好友或群聊，分享你的交易思路。</p><button type="button" onClick={onOpenFriendManager}>寻找交易伙伴</button></div>}
      </div>
      {active && <aside className="dc-details" aria-label={active.kind === 'dm' ? '好友资料' : '群组资料'}>
        <div className="dc-profile-banner"><button type="button" className="dc-icon-button dc-details-close" aria-label="关闭资料栏" onClick={() => setDetails(false)}><Icon name="close" /></button></div>
        <div className="dc-profile-body"><Avatar name={name} avatar={group?.avatar ?? active.avatar} size="lg" /><h2 className="dc-profile-name">{name}</h2><p className="dc-profile-meta">{active.kind === 'dm' ? (person?.username ? `@${person.username}` : '交易伙伴') : `${group?.members ?? members.length} 位成员`}</p>
          {active.kind === 'dm' ? <><div className="dc-profile-card"><h3>关于我</h3><p>{person?.bio || '这个人还没有填写简介。'}</p></div><button type="button" onClick={onOpenFriendManager}>管理好友</button></> : group && <GroupDetails key={group.id} group={group} members={members} onChanged={() => refreshGroup(group.id)} onError={onError ?? (() => undefined)} onMention={(nickname) => insertText(`@${nickname} `)} onLeave={() => {
            if (activeRef.current?.kind === 'group' && activeRef.current.id === group.id) { activeRef.current = null; setActive(null); setMessages([]); setMembers([]); setDetails(false); }
            void loadLists();
          }} />}
        </div>
      </aside>}
      {groupEntry && visible && <GroupEntry onClose={() => setGroupEntry(false)} onComplete={enterGroup} />}
    </section>
  );
}
