import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, stamp } from './api';
import { localTerminal, type LocalTerminalState } from './localTerminal';
import { pairLocalMT5 } from './mt5Pairing';
import { ReviewIcon, TradeIcon } from './ui/icons';

interface CloudStatus { status: 'none' | 'claimed' | 'approved' | 'rejected'; last_sync: number | null; expires_at: number | null }

export function MT5Connection({ state, open, onOpen, onClose }: { state: LocalTerminalState; open: boolean; onOpen: () => void; onClose: () => void }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const attempt = useRef<AbortController | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [kind, setKind] = useState<'syncnote' | 'synctrade' | null>(null);
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  const connected = state.phase === 'connected';
  const hasPairing = connected || state.phase === 'confirming' || cloud?.status === 'approved' || cloud?.status === 'claimed';
  const refresh = async (signal?: AbortSignal) => {
    const status = await api<CloudStatus>('/api/mt5/device/status', undefined, { signal });
    if (!signal?.aborted) setCloud(status);
  };
  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal).catch(() => {});
    const timer = window.setInterval(() => { void refresh(abort.signal).catch(() => {}); }, 5000);
    return () => { abort.abort(); clearInterval(timer); attempt.current?.abort(); };
  }, []);
  useEffect(() => {
    if (open) { if (!dialog.current?.open) dialog.current?.showModal(); if (!hasPairing) input.current?.focus(); }
    else dialog.current?.close();
  }, [open, hasPairing]);
  const close = () => { attempt.current?.abort(); onClose(); };
  const summary = connected ? 'SyncTrade · 本机已连接'
    : state.phase === 'confirming' ? 'SyncTrade · 等待 MT5 确认'
      : cloud?.status === 'claimed' ? 'SyncNote · 等待 MT5 确认'
        : cloud?.status === 'approved' ? (cloud.last_sync && Date.now() / 1000 - cloud.last_sync < 90 ? 'SyncNote · 数据同步中' : 'SyncNote · 已授权，等待续传')
          : cloud?.status === 'rejected' ? '已拒绝配对' : '未连接';

  /** 绿点 = 正在同步；红点 = 断了 / 没连上。名字只留 SyncTrade / SyncNote。 */
  const lastSync = cloud?.last_sync ?? 0;
  const syncing = connected || (cloud?.status === 'approved' && lastSync > 0 && Date.now() / 1000 - lastSync < 90);
  const eaName = connected || state.phase === 'confirming' ? 'SyncTrade'
    : cloud?.status === 'approved' || cloud?.status === 'claimed' ? 'SyncNote' : '未同步';
  return <div className="mt5-header-connection">
    <button type="button" className={`tool-btn mt5-connection-trigger ea-chip ${syncing ? 'on' : 'off'}`}
      aria-label={eaName === '未同步' ? '连接 MT5' : `连接设置：${summary}`} aria-haspopup="dialog" aria-expanded={open}
      onClick={onOpen} title={`${summary}；点击打开连接设置`}>
      <i className="ea-dot" aria-hidden="true" /><span>{eaName === '未同步' ? '连接 MT5' : eaName}</span>
    </button>
    {createPortal(<dialog ref={dialog} className="mt5-connect-dialog" aria-labelledby={`${id}-title`} onCancel={(event) => { event.preventDefault(); close(); }} onClose={onClose}>
      <div className="mt5-connect-head"><h2 id={`${id}-title`}>连接 MT5</h2><button type="button" className="tool-btn" aria-label="关闭连接窗口" onClick={close}>×</button></div>
      <p className="dim">{hasPairing ? '如需更换 EA，请先断开当前连接或解除同步授权。' : '输入 EA 图表上的配对码，自动识别 SyncNote 或 SyncTrade。'}</p>
      {cloud?.last_sync ? <p className="dim">最近同步 {stamp(cloud.last_sync)}</p> : null}
      {!hasPairing ? <form onSubmit={async (event) => {
        event.preventDefault();
        if (hasPairing || busy || !/^\d{8}$/.test(code)) return;
        const abort = new AbortController(); attempt.current = abort;
        setBusy(true); setError(''); setNotice('正在识别 EA…');
        try {
          const result = await api<{ kind: 'syncnote' | 'unknown' }>('/api/mt5/device/resolve', { code }, { signal: abort.signal });
          if (abort.signal.aborted) return;
          if (result.kind === 'syncnote') {
            setKind('syncnote');
            await api('/api/mt5/device/claim', { code }, { signal: abort.signal });
            setNotice('已识别 SyncNote。请回 MT5 核对同频账号，点击「允许只读同步」。');
            await refresh(abort.signal);
          } else {
            setKind('synctrade');
            setNotice('正在连接本机 EA…');
            await pairLocalMT5(localTerminal, code, abort.signal);
            setNotice('已识别 SyncTrade。请回 MT5 图表允许本次连接。');
          }
          if (!abort.signal.aborted) setCode('');
        } catch (err) { if (!abort.signal.aborted) { setNotice(''); setError(err instanceof Error ? err.message : '连接失败，请重试'); } }
        finally { if (attempt.current === abort) { attempt.current = null; setBusy(false); } }
      }}>
        <label htmlFor={`${id}-code`}>EA 配对码</label>
        <div className="local-buttons"><input ref={input} id={`${id}-code`} autoComplete="off" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} placeholder="输入 8 位配对码" value={code} disabled={busy} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} /><button type="submit" className="primary" disabled={busy || !/^\d{8}$/.test(code)}>{busy ? '连接中…' : '连接'}</button></div>
      </form> : null}
      <p role="status" className={`local-notice${!busy && !error && (connected || cloud?.status === 'approved') ? ' is-success' : ''}`} aria-live="polite">{busy ? notice : connected ? <><strong className="mt5-success-title">✓ SyncTrade 本机已连接</strong><span className="mt5-success-hint">可以关闭此窗口。行情与数据续传需保持网页打开。</span></> : cloud?.status === 'approved' ? <><strong className="mt5-success-title">✓ SyncNote 已授权只读同步</strong><span className="mt5-success-hint">可以关闭本页面了，保持 MT5 与 EA 运行即可继续同步。</span></> : cloud?.status === 'claimed' ? '已识别 SyncNote，请回 MT5 核对同频账号并允许只读同步。' : notice || (summary !== '未连接' ? summary : '')}</p>
      {error || (kind === 'synctrade' && state.error) ? <p className="local-error" role="alert">{error || state.error}</p> : null}
      {connected || state.phase === 'confirming' ? <button type="button" className="tool-btn" onClick={() => { localTerminal.disconnect(); setNotice('本机连接已断开。'); }}>断开本机连接</button> : null}
      {cloud?.status === 'approved' || cloud?.status === 'claimed' ? <button type="button" className="tool-btn" disabled={busy} onClick={async () => {
        if (!window.confirm('解除服务器同步授权？成交与复盘记录会保留，EA 后续同步会停止。')) return;
        setBusy(true);
        try { await api('/api/mt5/unlink', {}); await refresh(); setNotice('同步授权已解除。'); }
        catch (err) { setError(err instanceof Error ? err.message : '解除失败，请重试'); }
        finally { setBusy(false); }
      }}>解除同步授权</button> : null}
      <div className="mt5-install-help">
        <p>连接行情前，请先安装 MT5 EA（二选一）：</p>
        <div className="mt5-ea-editions">
          <div className="mt5-ea-edition"><ReviewIcon /><span><strong>SyncNote</strong><small>笔记版</small></span></div>
          <div className="mt5-ea-edition"><TradeIcon /><span><strong>SyncTrade</strong><small>交易版</small></span></div>
        </div>
        <a href="/local-ea" target="_blank" rel="noopener noreferrer">下载与安装说明<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3h7v7M21 3 11 13M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></svg><span className="mt5-link-hint">新窗口打开</span></a>
      </div>
    </dialog>, document.body)}
  </div>;
}
