import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

interface Friend { id: string; nickname: string; username?: string; avatar?: string; can_chat?: boolean }
interface Group { id: string; name: string; avatar?: string; members: number }
interface Recipient { kind: 'dm' | 'group'; id: string }
interface Target extends Recipient { name: string; avatar?: string; subtitle: string }
interface Props {
  ticket: string;
  note_id?: string;
  note?: unknown;
  snapshot: unknown;
  initialRecipient?: Recipient;
  onClose: () => void;
}
const keyOf = (target: Recipient) => `${target.kind}:${target.id}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const unknownOutcome = (error: unknown) => error instanceof SyntaxError || /网络连接中断|网站连接暂时异常|服务暂时不可用|HTTP\s*5\d\d|Failed to fetch|NetworkError|Load failed/i.test(errorText(error));
const recipientLabel = (targets: Target[]) => {
  const friends = targets.filter((target) => target.kind === 'dm').length;
  const groups = targets.length - friends;
  return [friends ? `${friends} 位好友` : '', groups ? `${groups} 个群聊` : ''].filter(Boolean).join('、');
};

function RecipientAvatar({ target }: { target: Target }) {
  const avatar = target.avatar && /^avatar(?:[1-9]|1[0-2])$/.test(target.avatar) ? target.avatar : null;
  return <span className="rs-avatar" aria-hidden="true">{avatar ? <img src={`/avatars/${avatar}.svg`} alt="" /> : target.name.slice(0, 2)}</span>;
}

/** 分享自己的复盘切片；好友和群聊共用选择、反馈与失败保留逻辑。 */
export function ReviewShareDialog({ ticket, note_id, note, snapshot, initialRecipient, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const loadVersion = useRef(0);
  const writing = useRef(false);
  const [targets, setTargets] = useState<Target[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialRecipient ? [keyOf(initialRecipient)] : []));
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sourceErrors, setSourceErrors] = useState<string[]>([]);
  const [failures, setFailures] = useState<string[]>([]);
  const [feedback, setFeedback] = useState('');
  const [uncertain, setUncertain] = useState<string[]>([]);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true); setSourceErrors([]);
    const [profile, groups] = await Promise.allSettled([
      api<{ friends: Friend[] }>('/api/profile'),
      api<{ groups: Group[] }>('/api/groups'),
    ]);
    if (!alive.current || loadVersion.current !== version) return;
    const options: Target[] = [];
    const errors: string[] = [];
    if (profile.status === 'fulfilled') {
      for (const friend of profile.value.friends ?? []) {
        if (friend.can_chat === false) continue;
        options.push({ kind: 'dm', id: friend.id, name: friend.nickname?.trim() || friend.username || '未命名好友', avatar: friend.avatar, subtitle: friend.username ? `@${friend.username}` : '好友' });
      }
    } else errors.push(`好友加载失败：${errorText(profile.reason)}`);
    if (groups.status === 'fulfilled') {
      for (const group of groups.value.groups ?? []) options.push({ kind: 'group', id: group.id, name: group.name?.trim() || '未命名群聊', avatar: group.avatar, subtitle: `${group.members} 位成员` });
    } else errors.push(`群聊加载失败：${errorText(groups.reason)}`);
    setTargets(options); setSourceErrors(errors); setLoading(false);
    setSelected((previous) => new Set([...previous].filter((key) => options.some((target) => keyOf(target) === key))));
  }, []);

  useEffect(() => {
    alive.current = true;
    const node = dialog.current;
    node?.showModal();
    searchInput.current?.focus();
    void load();
    return () => { alive.current = false; node?.close(); };
  }, [load]);

  const chosen = targets.filter((target) => selected.has(keyOf(target)));
  const friendCount = chosen.filter((target) => target.kind === 'dm').length;
  const frozen = busy || uncertain.length > 0;
  const toggle = (target: Target) => {
    if (frozen || sent.has(keyOf(target))) return;
    setFailures([]);
    setSelected((previous) => {
      const next = new Set(previous);
      const key = keyOf(target);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const send = async () => {
    if (!chosen.length || loading || writing.current || uncertain.length) return;
    writing.current = true; setBusy(true); setFailures([]); setFeedback('');
    const successes: Target[] = [];
    const errors: string[] = [];
    let ambiguous: Target[] = [];
    const complete = (done: Target[]) => {
      successes.push(...done);
      if (!alive.current) return;
      setSelected((previous) => new Set([...previous].filter((key) => !done.some((target) => keyOf(target) === key))));
      setSent((previous) => new Set([...previous, ...done.map(keyOf)]));
    };
    const friends = chosen.filter((target) => target.kind === 'dm');
    if (friends.length) {
      try {
        await api('/api/reviews/share', { ticket, note_id, note, recipients: friends.map((target) => target.id), message, snapshot });
        complete(friends);
      } catch (error) {
        if (unknownOutcome(error)) ambiguous = friends;
        else errors.push(`${friends.map((target) => target.name).join('、')}：${errorText(error)}`);
      }
    }
    if (!ambiguous.length) {
      for (const group of chosen.filter((target) => target.kind === 'group')) {
        try {
          await api('/api/groups/share', { group: group.id, ticket, note_id, note, message, snapshot });
          complete([group]);
        } catch (error) {
          if (unknownOutcome(error)) { ambiguous = [group]; break; }
          errors.push(`${group.name}：${errorText(error)}`);
        }
      }
    }
    writing.current = false;
    if (!alive.current) return;
    setBusy(false); setFailures(errors);
    if (successes.length) setFeedback(`已发送给 ${recipientLabel(successes)}。${errors.length || ambiguous.length ? '其余目标保留勾选。' : ''}`);
    if (ambiguous.length) setUncertain(ambiguous.map((target) => target.name));
    if (!errors.length && !ambiguous.length) setMessage('');
  };
  const close = () => { if (!writing.current) onClose(); };
  const matches = (target: Target) => `${target.name} ${target.subtitle}`.toLowerCase().includes(query.trim().toLowerCase());
  const renderSection = (kind: Target['kind'], title: string) => {
    const all = targets.filter((target) => target.kind === kind);
    const rows = all.filter(matches);
    return <section className="rs-section" aria-label={title}>
      <h3>{title}<span>{all.length}</span></h3>
      {rows.map((target) => {
        const key = keyOf(target);
        const alreadySent = sent.has(key);
        const checked = selected.has(key);
        const limitReached = kind === 'dm' && friendCount >= 20 && !checked;
        return <label className={`rs-recipient ${checked ? 'is-selected' : ''} ${alreadySent ? 'is-sent' : ''}`} key={key}>
          <input type="checkbox" aria-label={`${title}：${target.name}`} checked={checked} disabled={frozen || alreadySent || limitReached} onChange={() => toggle(target)} />
          <RecipientAvatar target={target} />
          <span className="rs-recipient-text"><b>{target.name}</b><small>{target.subtitle}</small></span>
          {alreadySent && <span className="rs-sent-label">已发送</span>}
        </label>;
      })}
      {!loading && !rows.length && <p className="rs-empty">{query.trim() ? '没有匹配结果' : kind === 'dm' ? '还没有可分享的好友' : '还没有加入群聊'}</p>}
    </section>;
  };

  return <dialog className="rs-dialog" ref={dialog} aria-labelledby="review-share-title" onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  }}>
    <div className="rs-header"><div><h2 id="review-share-title">分享复盘</h2><p>{ticket ? '关联订单 #' + ticket : '图表笔记'}</p></div><button type="button" className="rs-close" disabled={busy} aria-label="关闭分享复盘" onClick={close}>×</button></div>
    <label className="rs-search"><span>选择好友或群聊</span><input ref={searchInput} type="search" value={query} disabled={busy} placeholder="搜索好友、账号或群名" onChange={(event) => setQuery(event.target.value)} /></label>
    {loading && <p className="rs-loading" role="status">正在加载分享对象…</p>}
    {!!sourceErrors.length && <div className="rs-source-errors" role="alert">{sourceErrors.map((error) => <p key={error}>{error}</p>)}<button type="button" disabled={busy} onClick={() => void load()}>重新加载对象</button></div>}
    <div className="rs-targets">{renderSection('dm', '好友')}{renderSection('group', '群聊')}</div>
    <p className="rs-selection" aria-live="polite">{chosen.length ? `已选择 ${recipientLabel(chosen)}` : '请选择分享对象'}{friendCount >= 20 ? ' · 每次最多选择 20 位好友' : ''}</p>
    <label className="rs-message">附带留言<textarea rows={2} maxLength={500} value={message} disabled={frozen} placeholder="例如：看 15 分钟这段结构" onChange={(event) => setMessage(event.target.value)} /><small>{message.length}/500</small></label>
    {feedback && <p className="rs-feedback" role="status">{feedback}</p>}
    {!!failures.length && <div className="rs-errors" role="alert"><p>以下目标未发送成功，可修改选择后重试：</p>{failures.map((failure) => <p key={failure}>{failure}</p>)}</div>}
    {!!uncertain.length && <div className="rs-errors" role="alert"><p>发送结果待确认：{uncertain.join('、')}。</p><p>连接中断或响应异常，分享可能已经送达。请先到对应会话核对，再关闭此面板，避免重复发送。</p></div>}
    <div className="rs-footer"><button type="button" disabled={busy} onClick={close}>{sent.size ? '完成' : '取消'}</button><button type="button" className="primary" disabled={loading || frozen || !chosen.length} onClick={() => void send()}>{busy ? '正在分享…' : `发送${chosen.length ? `（${chosen.length}）` : ''}`}</button></div>
  </dialog>;
}
