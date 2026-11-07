import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, stamp } from './api';
import { localTerminal, type LocalTerminalState } from './localTerminal';
import { pairLocalMT5 } from './mt5Pairing';
import { ToolbarIcon } from './ui/ToolbarIcon';

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
    if (open) { if (!dialog.current?.open) dialog.current?.showModal(); input.current?.focus(); }
    else dialog.current?.close();
  }, [open]);
  const close = () => { attempt.current?.abort(); onClose(); };
  const summary = connected ? 'SyncTrade · 本机已连接'
    : state.phase === 'confirming' ? 'SyncTrade · 等待 MT5 确认'
      : cloud?.status === 'claimed' ? 'SyncNote · 等待 MT5 确认'
        : cloud?.status === 'approved' ? (cloud.last_sync && Date.now() / 1000 - cloud.last_sync < 90 ? 'SyncNote · 数据同步中' : 'SyncNote · 已授权，等待续传')
          : cloud?.status === 'rejected' ? '已拒绝配对' : '未连接';

  const authorized = connected || cloud?.status === 'approved';
  /** 绿点 = 正在同步；红点 = 断了 / 没连上。名字只留 SyncTrade / SyncNote。 */
  const lastSync = cloud?.last_sync ?? 0;
  const syncing = connected || (cloud?.status === 'approved' && lastSync > 0 && Date.now() / 1000 - lastSync < 90);
  const eaName = connected || state.phase === 'confirming' ? 'SyncTrade'
    : cloud?.status === 'approved' || cloud?.status === 'claimed' ? 'SyncNote' : '未同步';
  return <div className="mt5-header-connection">
    <button type="button" className="tool-btn" aria-label={authorized ? '连接设置' : '连接 MT5'} onClick={onOpen} title="MT5 连接设置"><ToolbarIcon name="terminal" /><span>{authorized ? '连接设置' : '连接 MT5'}</span></button>
    <span className={`link-state mt5-header-status ea-chip ${syncing ? 'on' : 'off'}`} title={summary} aria-label={summary} role="status"><i className="ea-dot" aria-hidden="true" />{eaName}</span>
    {createPortal(<dialog ref={dialog} className="mt5-connect-dialog" aria-labelledby={`${id}-title`} onCancel={(event) => { event.preventDefault(); close(); }} onClose={onClose}>
      <div className="mt5-connect-head"><h2 id={`${id}-title`}>连接 MT5</h2><button type="button" className="tool-btn" aria-label="关闭连接窗口" onClick={close}>×</button></div>
      <p className="dim">输入 EA 图表上的配对码，自动识别 SyncNote 或 SyncTrade。</p>
      {cloud?.last_sync ? <p className="dim">最近同步 {stamp(cloud.last_sync)}</p> : null}
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !/^\d{8}$/.test(code)) return;
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
      </form>
      <p role="status" className={`local-notice${!busy && !error && (connected || cloud?.status === 'approved') ? ' is-success' : ''}`} aria-live="polite">{busy ? notice : connected ? 'SyncTrade 本机已连接，交易权限以 EA 授权为准。' : cloud?.status === 'approved' ? 'SyncNote 已授权只读同步；MT5 运行时，关闭网页后仍会续传。' : cloud?.status === 'claimed' ? '已识别 SyncNote，请回 MT5 核对同频账号并允许只读同步。' : notice || (summary !== '未连接' ? summary : '')}</p>
      {error || (kind === 'synctrade' && state.error) ? <p className="local-error" role="alert">{error || state.error}</p> : null}
      {connected || state.phase === 'confirming' ? <button type="button" className="tool-btn" onClick={() => { localTerminal.disconnect(); setNotice('本机连接已断开。'); }}>断开本机连接</button> : null}
      {cloud?.status === 'approved' || cloud?.status === 'claimed' ? <button type="button" className="tool-btn" disabled={busy} onClick={async () => {
        if (!window.confirm('解除服务器同步授权？成交与复盘记录会保留，EA 后续同步会停止。')) return;
        setBusy(true);
        try { await api('/api/mt5/unlink', {}); await refresh(); setNotice('同步授权已解除。'); }
        catch (err) { setError(err instanceof Error ? err.message : '解除失败，请重试'); }
        finally { setBusy(false); }
      }}>解除同步授权</button> : null}
      <details><summary>安装与连接说明</summary><p className="dim">SyncNote 通过 HTTPS 直传，首次需把本站地址加入 MT5 的 WebRequest 白名单；关闭网页仍可同步。SyncTrade 通过本机 WebSocket 连接，由网页代传，网页关闭后续传暂停。</p><a href="/local-ea" target="_blank" rel="noopener noreferrer">下载 EA 与安装说明 ↗</a></details>
    </dialog>, document.body)}
  </div>;
}
