import { useEffect, useRef, useState } from 'react';
import { api } from './api';

interface Group {
  id: string;
  name: string;
  role: string;
  code?: string;
  avatar?: string;
  notice?: string;
  members: number;
}
interface Member {
  id: string;
  nickname: string;
  avatar?: string;
  role?: string;
  online?: boolean;
}
interface Props {
  group: Group;
  members: Member[];
  onChanged: () => Promise<void>;
  onLeave: () => void;
  onError: (message: string) => void;
  onMention?: (nickname: string) => void;
}
type Confirmation = { kind: 'leave' } | { kind: 'kick'; member: Member } | null;

/** 群资料与权限管理。由聊天区统一加载群和成员，这里只处理用户操作。 */
export function GroupDetails({ group, members, onChanged, onLeave, onError, onMention }: Props) {
  const owner = group.role === 'owner';
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [noticeDraft, setNoticeDraft] = useState<string | null>(null);
  const [showAvatars, setShowAvatars] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const copyRef = useRef<HTMLInputElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const report = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (alive.current) setError(message);
    onError(message);
  };
  const perform = async (path: string, body: unknown, success: string, after?: () => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setFeedback(''); setError('');
    try {
      await api(path, body);
      after?.();
      if (alive.current) setFeedback(success);
      try { await onChanged(); }
      catch { if (alive.current) setError('操作已完成，资料刷新失败，请稍后重新打开。'); }
    } catch (cause) { report(cause); }
    finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const saveName = async () => {
    if (!owner || nameDraft === null || !nameDraft.trim()) return;
    await perform('/api/groups/rename', { group: group.id, name: nameDraft.trim() }, '群名已保存', () => { if (alive.current) setNameDraft(null); });
  };
  const saveNotice = async () => {
    if (!owner || noticeDraft === null) return;
    await perform('/api/groups/notice', { group: group.id, notice: noticeDraft }, '群公告已保存', () => { if (alive.current) setNoticeDraft(null); });
  };
  const pickAvatar = async (avatar: string) => {
    if (!owner) return;
    await perform('/api/groups/rename', { group: group.id, avatar }, '群头像已更新', () => { if (alive.current) setShowAvatars(false); });
  };
  const copyInvite = async (link: boolean) => {
    if (!owner || !group.code) return;
    const text = link ? `${location.origin}/chart?group=${encodeURIComponent(group.code)}` : group.code;
    setError(''); setFeedback('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (alive.current) { setCopyFallback(null); setFeedback(link ? '邀请链接已复制' : '邀请码已复制'); }
    } catch {
      if (!alive.current) return;
      setCopyFallback(text);
      setFeedback('无法自动复制，请复制下面选中的内容。');
      window.requestAnimationFrame(() => { copyRef.current?.focus(); copyRef.current?.select(); });
    }
  };
  const confirmAction = async () => {
    if (!confirmation) return;
    if (confirmation.kind === 'kick') {
      if (!owner || confirmation.member.role === 'owner') return;
      await perform('/api/groups/kick', { group: group.id, target: confirmation.member.id }, '成员已移出群聊', () => { if (alive.current) setConfirmation(null); });
    } else {
      await perform('/api/groups/leave', { group: group.id }, '已退出群聊', () => { if (alive.current) setConfirmation(null); onLeave(); });
    }
  };
  const leaveMessage = owner
    ? group.members <= 1
      ? '你是最后一位成员。退出后将解散这个群聊并删除群内消息，无法恢复。'
      : '退出后，你将无法再查看或发送群消息；群主身份会转交给最早加入的其他成员。'
    : '退出后，你将无法再查看或发送群消息。需要重新取得邀请码才能加入。';

  return (
    <div className="gd-details" aria-busy={busy}>
      {owner && <section className="gd-section">
        <div className="gd-section-head"><h3>群资料</h3><span className="dim">群主可管理</span></div>
        {nameDraft === null ? <div className="gd-actions">
          <button type="button" disabled={busy} onClick={() => setNameDraft(group.name)}>修改群名</button>
          <button type="button" disabled={busy} aria-expanded={showAvatars} onClick={() => setShowAvatars((value) => !value)}>更换群头像</button>
        </div> : <form className="gd-form" onSubmit={(event) => { event.preventDefault(); void saveName(); }}>
          <label htmlFor={`gd-name-${group.id}`}>群名</label>
          <input id={`gd-name-${group.id}`} value={nameDraft} maxLength={40} disabled={busy} onChange={(event) => setNameDraft(event.target.value)} />
          <div className="gd-actions"><button type="submit" disabled={busy || !nameDraft.trim()}>保存群名</button><button type="button" disabled={busy} onClick={() => setNameDraft(null)}>取消</button></div>
        </form>}
        {showAvatars && <div className="gd-avatar-picker" aria-label="选择群头像">{Array.from({ length: 12 }, (_, index) => {
          const avatar = `avatar${index + 1}`;
          return <button type="button" key={avatar} disabled={busy} aria-label={`群头像 ${index + 1}`} aria-pressed={group.avatar === avatar} onClick={() => void pickAvatar(avatar)}><img src={`/avatars/${avatar}.svg`} alt="" /></button>;
        })}</div>}
      </section>}

      <section className="gd-section">
        <div className="gd-section-head"><h3>群公告</h3>{owner && noticeDraft === null && <button type="button" disabled={busy} onClick={() => setNoticeDraft(group.notice ?? '')}>编辑公告</button>}</div>
        {noticeDraft === null || !owner ? <p className="gd-notice">{group.notice || '暂时没有群公告。'}</p> : <form className="gd-form" onSubmit={(event) => { event.preventDefault(); void saveNotice(); }}>
          <label htmlFor={`gd-notice-${group.id}`}>群公告内容</label>
          <textarea id={`gd-notice-${group.id}`} value={noticeDraft} rows={4} maxLength={500} disabled={busy} onChange={(event) => setNoticeDraft(event.target.value)} />
          <small className="dim">{noticeDraft.length}/500</small>
          <div className="gd-actions"><button type="submit" disabled={busy}>保存公告</button><button type="button" disabled={busy} onClick={() => setNoticeDraft(null)}>取消</button></div>
        </form>}
      </section>

      {owner && group.code && <section className="gd-section gd-invite">
        <h3>邀请加入</h3><p>邀请码：<code>{group.code}</code></p>
        <div className="gd-actions"><button type="button" onClick={() => void copyInvite(false)}>复制邀请码</button><button type="button" onClick={() => void copyInvite(true)}>复制邀请链接</button></div>
        {copyFallback !== null && <label className="gd-form">手动复制邀请内容<input ref={copyRef} readOnly value={copyFallback} onFocus={(event) => event.currentTarget.select()} /></label>}
      </section>}

      <section className="gd-section gd-members">
        <h3>成员 · {group.members}</h3>
        {members.length ? members.map((member) => {
          const avatar = member.avatar && /^avatar(?:[1-9]|1[0-2])$/.test(member.avatar) ? member.avatar : null;
          return <div className="dc-member" key={member.id}>
            <span className="dc-avatar-wrap"><span className="dc-avatar sm" aria-hidden="true">{avatar ? <img src={`/avatars/${avatar}.svg`} alt="" /> : member.nickname.slice(0, 2)}</span>{member.online && <i className="dc-presence is-online" aria-label="在线" />}</span>
            <span title={member.nickname}>{member.nickname}</span>
            <small>{member.role === 'owner' ? '群主' : member.online ? '在线' : ''}</small>
            {onMention && <button type="button" className="dc-icon-button" title={`提及 ${member.nickname}`} aria-label={`提及 ${member.nickname}`} onClick={() => onMention(member.nickname)}>＠</button>}
            {owner && member.role !== 'owner' && <button type="button" className="gd-danger" disabled={busy} aria-label={`移除 ${member.nickname}`} onClick={() => { setError(''); setConfirmation({ kind: 'kick', member }); }}>移除</button>}
          </div>;
        }) : <p className="dim">正在加载成员…</p>}
      </section>

      {confirmation && <section className="gd-confirm" role="alert" aria-label={confirmation.kind === 'leave' ? '确认退出群聊' : '确认移除成员'}>
        <p>{confirmation.kind === 'leave' ? leaveMessage : `将「${confirmation.member.nickname}」移出「${group.name}」？对方将失去这个群聊的访问权限。`}</p>
        <div className="gd-actions"><button type="button" className="gd-danger" disabled={busy} onClick={() => void confirmAction()}>{confirmation.kind === 'leave' ? '确认退出' : '确认移除'}</button><button type="button" disabled={busy} onClick={() => setConfirmation(null)}>取消</button></div>
      </section>}
      {error && <p className="gd-feedback is-error" role="alert">{error}</p>}
      {feedback && <p className="gd-feedback" role="status">{feedback}</p>}
      <button type="button" className="gd-danger gd-leave" disabled={busy} onClick={() => { setError(''); setConfirmation({ kind: 'leave' }); }}>退出群聊</button>
    </div>
  );
}
