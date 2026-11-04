import { useEffect, useRef, useState } from 'react';
import { api } from './api';

interface Props {
  onClose: () => void;
  onComplete: (group: { id: string; name: string; avatar?: string; members: number; role: string; code?: string; notice?: string; unread: number }) => Promise<void>;
}

/** 建群和邀请码加入在聊天内完成，不再跳转到另一套群聊页面。 */
export function GroupEntry({ onClose, onComplete }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const writing = useRef(false);
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    node?.querySelector('input')?.focus();
    return () => node?.close();
  }, []);
  const submit = async () => {
    const value = (mode === 'create' ? name : code).trim();
    if (!value || writing.current) return;
    writing.current = true; setBusy(true); setError('');
    try {
      const group = await api<Parameters<Props['onComplete']>[0]>(`/api/groups/${mode}`, mode === 'create' ? { name: value } : { code: value });
      await onComplete(group);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      writing.current = false; setBusy(false);
    }
  };
  return <dialog className="dc-group-dialog" ref={dialog} aria-labelledby="group-entry-title" onCancel={(event) => { event.preventDefault(); if (!writing.current) onClose(); }}>
    <div className="dc-group-dialog-head"><h2 id="group-entry-title">与交易伙伴一起交流</h2><button type="button" aria-label="关闭创建或加入群" disabled={busy} onClick={onClose}>×</button></div>
    <div className="dc-group-dialog-tabs" role="group" aria-label="群聊操作">
      <button type="button" aria-pressed={mode === 'create'} disabled={busy} onClick={() => { setMode('create'); setError(''); }}>创建群聊</button>
      <button type="button" aria-pressed={mode === 'join'} disabled={busy} onClick={() => { setMode('join'); setError(''); }}>加入群聊</button>
    </div>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label htmlFor="group-entry-value">{mode === 'create' ? '群聊名称' : '群邀请码'}</label>
      <input id="group-entry-value" autoFocus disabled={busy} maxLength={mode === 'create' ? 40 : 12} value={mode === 'create' ? name : code} placeholder={mode === 'create' ? '例如：黄金交易研习室' : '输入群主提供的邀请码'} onChange={(event) => mode === 'create' ? setName(event.target.value) : setCode(event.target.value)} />
      <p>{mode === 'create' ? '创建后自动进入群聊，公告和成员管理都在右侧资料栏。' : '加入后直接打开对应群聊，原有会话和草稿会保留。'}</p>
      {error && <p className="dc-group-error" role="alert">{error}</p>}
      <button type="submit" className="primary" disabled={busy || !(mode === 'create' ? name : code).trim()}>{busy ? '正在处理…' : mode === 'create' ? '创建并进入群聊' : '加入并进入群聊'}</button>
    </form>
  </dialog>;
}
