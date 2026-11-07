import { useSyncExternalStore } from 'react';
import { localTerminal, type LocalTerminalState, type NoteReviewBars } from './localTerminal';
import { historyAccountKey } from './localHistorySync';

export interface LocalRangeState {
  phase: 'idle' | 'running' | 'paused' | 'error';
  message: string;
  jobId: string | null;
  segments: number;
  lastUpdated: number | null;
}
interface Segment {
  job_id: string; segment_id: string; account_key: string; account: string; server: string;
  symbol: string; tf: string; from_server: number; to_server: number;
}
interface Ack {
  ok: boolean; job_id: string; segment_id: string; account_key: string;
  symbol: string; tf: string; from_server: number; to_server: number; accepted: number; status: string;
}
interface Identity { website_user_id: string; account: string; server: string; account_key: string }
interface ResultBody extends Identity, Segment { bars: number[][]; error: string }
interface Dependencies {
  terminal: Pick<typeof localTerminal, 'getSnapshot' | 'subscribe' | 'requestReviewBars'>;
  accountKey: (server: string, account: string) => Promise<string>;
  post: (path: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<any>;
  now: () => number;
  schedule?: (callback: () => void, delay: number) => number;
  cancelSchedule?: (id: number) => void;
}
const periods: Record<string, number> = { M1: 60, M5: 300, M15: 900, H1: 3600 };
const wire: Record<string, string> = { M1: '1m', M5: '5m', M15: '15m', H1: '1h' };
const settled = new Set(['completed', 'rejected']);
const sessionKey = (state: LocalTerminalState) => [state.instance_id, state.account_id, state.server, state.epoch, state.symbol].join('\n');
const fresh = (): LocalRangeState => ({ phase: 'idle', message: '', jobId: null, segments: 0, lastUpdated: null });
const errorCode = (error: unknown) => String((error as { code?: string })?.code ?? (error instanceof Error ? error.message : error));
const busyError = (error: unknown) => ['history_read_busy', 'HISTORY_BUSY', 'BARS_BUSY'].includes(errorCode(error));
const unavailableError = (error: unknown) => ['HISTORY_UNAVAILABLE', 'HISTORY_TIMEOUT'].includes(errorCode(error));

/** Explicit website range jobs only. This class never sends or retries trade commands. */
export class LocalRangeSync {
  private state = fresh();
  private userId = '';
  private session = '';
  private identity: Identity | null = null;
  private enabled = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private timer: number | null = null;
  private running: Promise<void> | null = null;
  private segment: Segment | null = null;
  private rows = new Map<number, number[]>();
  private attempts = 0;
  private unavailableAttempts = 0;
  private pending: ResultBody | null = null;
  private listeners = new Set<() => void>();
  constructor(private readonly deps: Dependencies) {
    deps.terminal.subscribe(() => {
      if (!this.enabled) return;
      const current = deps.terminal.getSnapshot();
      if (current.phase !== 'connected' || sessionKey(current) !== this.session) this.stop('本机连接、账户或品种已改变，区间同步已暂停。');
    });
  }
  getSnapshot = () => this.state;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  private update(patch: Partial<LocalRangeState>) { this.state = { ...this.state, ...patch }; for (const callback of this.listeners) callback(); }
  bindUser(userId: string) {
    if (userId === this.userId) return;
    this.stop(''); this.userId = userId; this.state = fresh(); for (const callback of this.listeners) callback();
  }
  stop(message = '区间同步已暂停；保持当前网页和本机 EA 连接后可继续。') {
    this.enabled = false; this.generation += 1;
    this.controller?.abort(); this.controller = null;
    if (this.timer !== null) (this.deps.cancelSchedule ?? ((id) => window.clearTimeout(id)))(this.timer);
    this.timer = null; this.session = ''; this.identity = null; this.segment = null; this.rows.clear(); this.pending = null;
    this.attempts = 0; this.unavailableAttempts = 0; this.running = null;
    this.update({ phase: message ? 'paused' : 'idle', message, jobId: null });
  }
  start(): Promise<void> {
    const terminal = this.deps.terminal.getSnapshot();
    if (!this.userId || terminal.phase !== 'connected' || !terminal.features.includes('history') || !terminal.history_ready) {
      this.update({ phase: 'error', message: '请先连接支持历史读取的 SyncTrade，并等待图表初始化完成。' });
      return Promise.resolve();
    }
    if (this.enabled) return this.running ?? Promise.resolve();
    this.enabled = true; this.session = sessionKey(terminal); this.controller = new AbortController(); this.identity = null;
    this.update({ phase: 'running', message: '通过本机 SyncTrade 同步所选行情…', segments: 0 });
    return this.tick(this.generation);
  }
  private active(generation: number) {
    return this.enabled && generation === this.generation && !!this.controller && !this.controller.signal.aborted
      && this.deps.terminal.getSnapshot().phase === 'connected' && sessionKey(this.deps.terminal.getSnapshot()) === this.session;
  }
  private tradeBusy() {
    const state = this.deps.terminal.getSnapshot();
    return state.symbol_switching || state.commands.some((command) => command.account_id === state.account_id && command.server === state.server && !settled.has(command.state));
  }
  private schedule(generation: number, delay: number) {
    if (!this.active(generation)) return;
    this.timer = (this.deps.schedule ?? ((callback, ms) => window.setTimeout(callback, ms)))(() => { this.timer = null; void this.tick(generation); }, delay);
  }
  private fail(message: string) { this.stop(''); this.update({ phase: 'error', message }); }
  private tick(generation: number): Promise<void> {
    if (this.running) return this.running;
    const work = this.step(generation);
    this.running = work;
    return work.finally(() => { if (this.running === work) this.running = null; });
  }
  private validateSegment(segment: Segment) {
    const p = periods[segment.tf];
    return this.identity && segment.account_key === this.identity.account_key && segment.account === this.identity.account && segment.server === this.identity.server
      && typeof segment.job_id === 'string' && segment.job_id.length > 0 && segment.job_id.length <= 128
      && typeof segment.segment_id === 'string' && segment.segment_id.length > 0 && segment.segment_id.length <= 128
      && typeof segment.symbol === 'string' && segment.symbol.length > 0 && segment.symbol.length <= 128 && p
      && Number.isInteger(segment.from_server) && Number.isInteger(segment.to_server) && segment.from_server > 0 && segment.to_server >= segment.from_server
      && segment.from_server % p === 0 && segment.to_server % p === 0 && (segment.to_server - segment.from_server) / p + 1 <= 2000
      && segment.to_server + p <= Math.floor(this.deps.now() / 1000) + this.deps.terminal.getSnapshot().server_offset_sec;
  }
  private acceptPage(page: NoteReviewBars, segment: Segment) {
    if (page.symbol !== segment.symbol || page.tf !== wire[segment.tf] || page.time_basis !== 'broker_server'
      || page.range?.from_server !== segment.from_server || page.range?.to_server !== segment.to_server || !Array.isArray(page.bars) || page.bars.length > 2000) throw new Error('本机返回的区间行情身份不一致，已停止同步。');
    let previous = 0;
    for (const row of page.bars) {
      if (!Array.isArray(row) || row.length < 5 || !row.slice(0, 5).every(Number.isFinite) || !Number.isInteger(row[0])
        || row[0] < segment.from_server || row[0] > segment.to_server || row[0] % periods[segment.tf] || row[0] <= previous
        || row[1] <= 0 || row[3] <= 0 || row[4] <= 0 || row[2] < Math.max(row[1], row[4]) || row[3] > Math.min(row[1], row[4]) || row[2] < row[3]
        || (row.length > 5 && (!Number.isFinite(row[5]) || row[5] < 0))) throw new Error('本机返回无效 K 线，未上传或推进任务。');
      previous = row[0]; this.rows.set(row[0], row.slice());
    }
  }
  private validAck(ack: Ack, pending: ResultBody) {
    return ack?.ok === true && ack.job_id === pending.job_id && ack.segment_id === pending.segment_id && ack.account_key === pending.account_key
      && ack.symbol === pending.symbol && ack.tf === pending.tf && ack.from_server === pending.from_server && ack.to_server === pending.to_server
      && ack.accepted === pending.bars.length && ['running', 'partial', 'completed'].includes(ack.status);
  }
  private async step(generation: number): Promise<void> {
    let delay = 1000;
    try {
      if (!this.active(generation)) return;
      if (this.tradeBusy()) { this.update({ message: '交易指令结果尚未确认，区间同步等待核实。' }); delay = 5000; return; }
      const terminal = this.deps.terminal.getSnapshot();
      if (!this.identity) {
        const key = await this.deps.accountKey(terminal.server, terminal.account_id);
        if (!this.active(generation)) return;
        this.identity = { website_user_id: this.userId, account: terminal.account_id, server: terminal.server, account_key: key };
      }
      const signal = this.controller!.signal;
      if (!this.segment && !this.pending) {
        const response = await this.deps.post('/api/market/sync-jobs/local-poll', { ...this.identity }, signal);
        if (!this.active(generation)) return;
        if (response?.ok !== true || !('job' in response)) throw new Error('服务器未确认区间任务。');
        if (response.job === null) { this.enabled = false; this.controller = null; this.update({ phase: 'idle', jobId: null, message: '当前区间任务已处理；缺失情况以服务器进度为准。' }); return; }
        if (!this.validateSegment(response.job)) throw new Error('服务器返回的区间任务与当前账户不一致。');
        this.segment = response.job; this.rows.clear(); this.attempts = 0; this.unavailableAttempts = 0;
        this.update({ jobId: this.segment!.job_id, message: `正在读取 ${this.segment!.symbol} ${this.segment!.tf} 区间行情…` });
        return;
      }
      if (!this.pending && this.segment) {
        const segment = this.segment;
        try {
          const page = await this.deps.terminal.requestReviewBars(segment.symbol, wire[segment.tf], { from_server: segment.from_server, to_server: segment.to_server }, signal);
          if (!this.active(generation)) return;
          this.acceptPage(page, segment); this.attempts += 1;
        } catch (error) {
          if (!this.active(generation)) return;
          if (busyError(error)) { this.update({ message: '本机正在读取其他历史，稍后继续同一区间。' }); delay = 5000; return; }
          if (!unavailableError(error)) { this.fail(error instanceof Error ? error.message : '本机历史读取失败，区间同步已停止。'); return; }
          this.unavailableAttempts += 1;
          if (this.unavailableAttempts < 12) { this.update({ message: '等待 MT5 加载所选区间历史…' }); delay = 5000; return; }
        }
        const expected = (segment.to_server - segment.from_server) / periods[segment.tf] + 1;
        if (this.rows.size < expected && this.attempts < 3 && this.unavailableAttempts < 12) { delay = 2000; return; }
        const bars = [...this.rows.values()].sort((a, b) => a[0] - b[0]);
        this.pending = { ...this.identity!, ...segment, bars,
          error: bars.length === expected ? '' : this.unavailableAttempts >= 12 ? 'history_unavailable' : bars.length ? 'partial_window' : 'empty_window' };
        return;
      }
      if (this.pending) {
        const pending = this.pending;
        const ack = await this.deps.post('/api/market/sync-jobs/local-result', { ...pending }, signal);
        if (!this.active(generation)) return;
        if (!this.validAck(ack, pending)) throw new Error('服务器未精确确认区间数据，原批次已保留等待重试。');
        this.segment = null; this.pending = null; this.rows.clear(); this.attempts = 0; this.unavailableAttempts = 0;
        this.update({ segments: this.state.segments + 1, lastUpdated: this.deps.now(), message: '本批区间已确认，继续处理下一段…' });
        if (ack.status === 'completed' || ack.status === 'partial') {
          this.enabled = false; this.controller = null; this.identity = null;
          this.update({ phase: 'idle', jobId: null, message: ack.status === 'completed' ? '所选区间已同步。' : '区间已处理，部分时段缺少行情；请查看服务器进度。' });
        }
      }
    } catch (error) {
      if (!this.active(generation)) return;
      const status = (error as { status?: number })?.status;
      if (status === 401 || status === 403 || status === 409 || status === 400) { this.fail(error instanceof Error ? error.message : '同步授权或账户已改变，已停止。'); return; }
      // Only transport/upload acknowledgement errors retry automatically. Invalid EA data fails closed.
      if (!this.pending && error instanceof Error && /身份不一致|无效 K 线|任务与当前账户不一致/.test(error.message)) { this.fail(error.message); return; }
      this.update({ message: error instanceof Error ? error.message : '区间同步暂时失败，将重试当前分段。' }); delay = 5000;
    } finally { this.schedule(generation, delay); }
  }
}
async function post(path: string, body: Record<string, unknown>, signal: AbortSignal) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `区间同步失败（HTTP ${response.status}）`), { status: response.status });
  return data;
}
export const localRangeSync = new LocalRangeSync({ terminal: localTerminal, accountKey: historyAccountKey, post, now: () => Date.now() });
export const useLocalRangeSync = () => useSyncExternalStore(localRangeSync.subscribe, localRangeSync.getSnapshot);
