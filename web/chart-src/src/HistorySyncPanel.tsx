import { useState } from 'react';
import { stamp } from './api';
import { localHistorySync, useLocalHistorySync } from './localHistorySync';
import type { LocalTerminalState } from './localTerminal';

export function HistorySyncPanel({ terminal }: { terminal: LocalTerminalState }) {
  const sync = useLocalHistorySync();
  const [error, setError] = useState('');
  const available = terminal.phase === 'connected' && terminal.features.includes('history') && terminal.history_ready;
  const toggle = async (enabled: boolean) => {
    setError('');
    if (!enabled) { localHistorySync.stop(); return; }
    try { await localHistorySync.start(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <section className="history-sync">
    <h3>交易笔记同步</h3>
    <label className="history-sync-toggle"><input type="checkbox" checked={sync.enabled} disabled={!sync.enabled && !available} onChange={(event) => void toggle(event.target.checked)} /><span>同步本机交易到笔记</span></label>
    <p className="dim">开启后，将当前 MT5 账户最近 365 天的全品种成交与费用上传到当前网站账户。平时回查最近一天，每隔约 24 小时再完整核对 365 天。余额、净值和未平仓持仓不会随此功能上传。</p>
    {!available && !sync.enabled ? <p className="dim">{terminal.phase !== 'connected' ? '连接 SyncTrade（SyncNote Pro）后可开启。' : !terminal.features.includes('history') ? '当前 EA 不支持笔记历史分页，请换用新版 SyncTrade。' : '正在初始化图表，请稍候。'}</p> : null}
    {sync.account ? <p className="dim sync-line" title={`同步账户 ${sync.account} · ${sync.server}`}>同步账户 {sync.account} · {sync.server}</p> : null}
    <p className={error || sync.status === 'error' ? 'local-error sync-line' : 'dim sync-line'} role={error || sync.status === 'error' ? 'alert' : undefined} title={error || sync.message || '默认关闭。每页收到网站确认后才保存进度，重新开启可继续。'}>{error || sync.message || '默认关闭。每页收到网站确认后才保存进度，重新开启可继续。'}</p>
    {/* 进度行常驻占位：数字和文案一变长短，面板就不会上下跳。 */}
    <p className="dim sync-line" title={sync.pages ? `本次已确认 ${sync.pages} 页 · ${sync.deals} 条原始历史` : '还没有确认过的历史页'}>
      {sync.pages ? `本次已确认 ${sync.pages} 页 · ${sync.deals} 条原始历史${sync.last_synced ? ` · ${stamp(sync.last_synced / 1000)}` : ''}` : '本次已确认 0 页 · 0 条原始历史'}
    </p>
    <p className="dim sync-line" title={sync.last_full ? stamp(sync.last_full / 1000) : '—'}>上次完整核对 {sync.last_full ? stamp(sync.last_full / 1000) : '—'}</p>
    <p className="dim sync-line" title={sync.review_message || '—'}>{sync.review_message || '—'}</p>
    {sync.enabled && sync.status === 'error' ? <button type="button" className="tool-btn" onClick={() => localHistorySync.retry()}>安全重试历史同步</button> : null}
    <p className="dim">关闭网页或断开 EA 会暂停；重新打开后需再次开启。需要在关闭网页后继续同步，可选择 <a href="/local-ea" target="_blank" rel="noopener noreferrer">SyncNote 后台笔记 EA ↗</a>。</p>
  </section>;
}
