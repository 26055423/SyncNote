import { useEffect, useId, useRef, useState } from 'react';
import { api, stamp } from './api';
import { getDisplayZone } from './lib/time';
import { calendarSyncRange, dateInZone, shiftDate } from './lib/dateRange';

export interface SyncJob {
  transport?: 'syncnote' | 'synctrade';
  job_id: string;
  symbol: string;
  from: number;
  to: number;
  status: 'waiting' | 'running' | 'partial' | 'completed' | 'error' | 'cancelled';
  processed_segments: number;
  total_segments: number;
  bars_received: number;
  last_error: string | null;
  updated: number;
}
interface JobResponse { job: SyncJob | null }
const active = (job: SyncJob | null) => job?.status === 'waiting' || job?.status === 'running';
const labels: Record<SyncJob['status'], string> = {
  waiting: '等待 SyncNote 接收', running: '正在同步行情', partial: '区间已处理，部分时段无数据',
  completed: '所选区间已同步', error: '同步未完成', cancelled: '同步已取消',
};

interface LocalSyncContext { website_user_id: string; account: string; server: string; account_key: string }
export interface MarketRangeSyncProps {
  symbol: string;
  transport?: 'syncnote' | 'synctrade';
  getLocalContext?: () => Promise<LocalSyncContext>;
  onStartLocal?: () => Promise<void> | void;
  onStopLocal?: () => void;
  localStatus?: { phase: string; message: string };
  onUpdated?: () => void;
  onJobChange?: (job: SyncJob | null) => void;
  onViewBars?: () => void;
}
export function MarketRangeSync({ symbol, transport = 'syncnote', getLocalContext, onStartLocal, onStopLocal, localStatus, onUpdated, onJobChange, onViewBars }: MarketRangeSyncProps) {
  const id = useId();
  const zone = getDisplayZone();
  const today = dateInZone(Date.now(), zone);
  const [preset, setPreset] = useState<number | 'custom'>(7);
  const [start, setStart] = useState(() => shiftDate(today, -6));
  const [end, setEnd] = useState(today);
  const [jobState, setJob] = useState<SyncJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const symbolRef = useRef(symbol);
  const scopeRef = useRef(`${transport}:${symbol}`);
  scopeRef.current = `${transport}:${symbol}`;
  const jobRef = useRef<SyncJob | null>(null);
  const notified = useRef('');
  const callback = useRef(onUpdated);
  callback.current = onUpdated;
  const contextCallback = useRef(getLocalContext);
  contextCallback.current = getLocalContext;
  const jobCallback = useRef(onJobChange);
  jobCallback.current = onJobChange;
  symbolRef.current = symbol;
  const apply = (value: SyncJob | null) => {
    if (value && value.symbol !== symbolRef.current) return;
    if (value?.transport && value.transport !== transport) return;
    if (value && jobRef.current?.job_id === value.job_id && value.updated < jobRef.current.updated) return;
    jobRef.current = value;
    setJob(value);
    jobCallback.current?.(value);
    if (value && value.bars_received > 0) {
      const key = `${value.job_id}:${value.bars_received}:${value.processed_segments}:${value.status}`;
      if (notified.current !== key) { notified.current = key; callback.current?.(); }
    }
  };
  useEffect(() => {
    let alive = true, timer: number | null = null;
    setLoading(true); setJob(null); setError(''); setPollError(''); setBusy(false); notified.current = ''; jobRef.current = null;
    const poll = async () => {
      const requestedJob = jobRef.current;
      try {
        const query = new URLSearchParams({ symbol, transport });
        if (transport === 'synctrade') {
          if (!contextCallback.current) throw new Error('请先连接 SyncTrade，再读取同步状态。');
          const context = await contextCallback.current();
          if (!alive) return;
          query.set('account_key', context.account_key);
        }
        const result = await api<JobResponse>('/api/market/sync-jobs?' + query);
        if (!alive) return;
        // A response started before create/cancel must not replace that newer action.
        if (jobRef.current === requestedJob || (result.job && result.job.job_id === jobRef.current?.job_id)) apply(result.job);
        setPollError('');
      } catch (err) { if (alive) setPollError(err instanceof Error ? err.message : '同步状态读取失败。'); }
      finally { if (alive) { setLoading(false); timer = window.setTimeout(poll, 3000); } }
    };
    void poll();
    return () => { alive = false; if (timer !== null) window.clearTimeout(timer); };
  }, [symbol, transport]);

  const job = jobState?.symbol === symbol ? jobState : null;
  const waiting = active(job);
  const local = transport === 'synctrade';
  const canResume = local && waiting && (!localStatus || ['idle', 'paused', 'error'].includes(localStatus.phase));
  const progress = job?.status === 'completed' ? 100
    : job && job.total_segments > 0 ? Math.min(100, Math.floor(job.processed_segments / job.total_segments * 100)) : 0;
  return <section className="market-range-sync" aria-labelledby={`${id}-heading`}>
    <div className="market-range-head"><h3 id={`${id}-heading`}>同步行情</h3><span>{symbol}</span></div>
    <p className="market-range-intro">{local ? '选择区间，通过已授权的 SyncTrade 本机连接读取并同步四周期 K 线。' : '选择区间，由已授权的 SyncNote 获取该品种的四周期 K 线。'}</p>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (busy || loading || waiting || !symbol) return;
      const requestedSymbol = symbol;
      const requestedScope = scopeRef.current;
      setError('');
      try {
        const range = preset === 'custom' ? calendarSyncRange(start, end, zone)
          : calendarSyncRange(shiftDate(dateInZone(Date.now(), zone), 1 - preset), dateInZone(Date.now(), zone), zone);
        setBusy(true);
        if (local && (!getLocalContext || !onStartLocal)) throw new Error('请先连接 SyncTrade，再同步行情。');
        const context = local ? await getLocalContext!() : {};
        if (scopeRef.current !== requestedScope) return;
        const result = await api<JobResponse>('/api/market/sync-jobs', { ...context, symbol, ...range, transport });
        if (symbolRef.current === requestedSymbol && scopeRef.current === requestedScope) {
          apply(result.job);
          if (local && result.job && ['waiting', 'running'].includes(result.job.status)) await onStartLocal!();
        }
      } catch (err) { if (scopeRef.current === requestedScope) setError(err instanceof Error ? err.message : '同步任务创建失败。'); }
      finally { if (scopeRef.current === requestedScope) setBusy(false); }
    }}>
      <div className="market-range-presets" role="group" aria-label="同步区间">
        {[7, 30, 90].map((days) => <button type="button" key={days} aria-pressed={preset === days} disabled={busy || waiting} onClick={() => setPreset(days)}>近 {days} 天</button>)}
        <button type="button" aria-pressed={preset === 'custom'} disabled={busy || waiting} onClick={() => setPreset('custom')}>自定义</button>
      </div>
      {preset === 'custom' ? <div className="market-range-dates">
        <label>开始日期<input aria-label="行情同步开始日期" type="date" value={start} max={today} required disabled={busy || waiting} onChange={(event) => setStart(event.target.value)} /></label>
        <label>结束日期<input aria-label="行情同步结束日期" type="date" value={end} min={start} max={today} required disabled={busy || waiting} onChange={(event) => setEnd(event.target.value)} /></label>
      </div> : null}
      <div className="market-range-zone">日期按显示时区 {zone}，最多 365 天。</div>
      <button type="submit" className="primary" disabled={busy || loading || waiting || !symbol}>{busy ? '提交中…' : waiting ? '同步任务进行中' : '同步行情'}</button>
    </form>
    {job ? <div className={`market-range-status is-${job.status}`} role="status" aria-live="polite">
      <strong>{local && job.status === 'waiting' ? '等待 SyncTrade 读取' : labels[job.status]}</strong>
      <p>{stamp(job.from)} — {stamp(job.to - 1)}</p>
      <progress aria-label="行情同步进度" value={progress} max={100} />
      <div className="market-range-count"><span>已处理 {job.processed_segments} / {job.total_segments} 段</span><span>已接收 {job.bars_received.toLocaleString()} 根</span></div>
      {job.status === 'completed' && job.total_segments === 0 ? <p>所选区间已覆盖，或属于券商常规休市，无需重新读取。</p> : null}
      {waiting ? <p>{local ? '请保持本网页、MT5 与 SyncTrade 运行；关闭网页或断开本机连接会暂停，可重新连接后继续。' : '请保持 MT5 和 SyncNote 1.016 或更新版本运行；无需换到这个品种的图表。'}</p> : null}
      {local && waiting && localStatus?.message ? <p>{localStatus.message}</p> : null}
      {canResume ? <button type="button" className="primary" disabled={busy || !onStartLocal} onClick={async () => {
        const requestedScope = scopeRef.current;
        setBusy(true); setError('');
        try { await onStartLocal?.(); }
        catch (err) { if (scopeRef.current === requestedScope) setError(err instanceof Error ? err.message : '继续同步失败，请重新连接后重试。'); }
        finally { if (scopeRef.current === requestedScope) setBusy(false); }
      }}>继续同步</button> : null}
      {job.status === 'partial' ? <p>休市或券商历史缺失的时段未计为完整覆盖，可补齐 MT5 历史后重新同步。</p> : null}
      {(job.status === 'partial' || job.status === 'error') && job.bars_received > 0 && onViewBars ? <button type="button" className="primary" onClick={onViewBars}>查看已同步 K 线</button> : null}
      {job.last_error ? <p className="market-range-detail">{({ history_unavailable: 'MT5 暂未提供这段历史，请等待下载或补齐 MT5 历史后重新同步。', empty_window: '这段区间未返回 K 线，可能为休市或券商未提供历史。', partial_window: '这段区间只返回了部分 K 线，已保存实际收到的数据。' } as Record<string, string>)[job.last_error] || job.last_error}</p> : null}
      {waiting ? <button type="button" className="tool-btn" disabled={busy} onClick={async () => {
        const requestedSymbol = symbol;
        const requestedScope = scopeRef.current;
        setBusy(true); setError('');
        try {
          const context = local ? await getLocalContext!() : {};
          if (scopeRef.current !== requestedScope) return;
          const result = await api<JobResponse>('/api/market/sync-jobs/cancel', { ...context, job_id: job.job_id, transport });
          if (symbolRef.current === requestedSymbol && scopeRef.current === requestedScope) { if (local) onStopLocal?.(); apply(result.job); }
        } catch (err) { if (scopeRef.current === requestedScope) setError(err instanceof Error ? err.message : '取消失败，请重试。'); }
        finally { if (scopeRef.current === requestedScope) setBusy(false); }
      }}>取消同步</button> : null}
    </div> : <p className="market-range-note">{local ? '使用 SyncTrade 1.109 或更新版本，通过本网页代传行情。请保持网页、MT5 与本机连接，关闭网页会暂停。' : '需要 SyncNote 1.016 或更新版本。提交后可关闭网页，MT5 与 EA 需保持运行。'}</p>}
    {error || pollError ? <p className="local-error" role="alert">{error || pollError}</p> : null}
  </section>;
}
