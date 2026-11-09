import { useSyncExternalStore } from 'react';
import { localTerminal, type LocalTerminalState } from './localTerminal';
import { historyAccountKey } from './localHistorySync';

/** Automatic backfill repairs only the recent seven days; charts never wait for it. */
export type BackfillPhase = 'idle' | 'initializing' | 'ready' | 'partial_ready' | 'error' | 'paused';
export interface BackfillState {
  phase: BackfillPhase;
  message: string;
  locked: boolean;
  symbol: string;
  segments: number;
  reachedServer: number | null;
  flooredTfs: string[];
  /** Successful upload time in UTC milliseconds; the host may refresh track heads. */
  lastUpdated: number | null;
  /** An old-gap upload ACK may change interior rows without moving the latest bar. */
  repairUpdated: number | null;
}
type Tf = 'M1' | 'M5' | 'M15' | 'H1';
const TFS: Tf[] = ['M1', 'M5', 'M15', 'H1'];
const TF_SECONDS: Record<Tf, number> = { M1: 60, M5: 300, M15: 900, H1: 3600 };
const TF_WIRE: Record<Tf, string> = { M1: '1m', M5: '5m', M15: '15m', H1: '1h' };
const MAX_BARS = 2000;
const RECENT_SECONDS = 7 * 86400;
const DELTA_MS = 60_000;
const GAP_RETRY_MS = 10 * 60_000;
const sessionKey = (s: LocalTerminalState) => [s.instance_id, s.account_id, s.server, s.epoch, s.symbol].join('\n');
interface Checkpoint {
  version: 2;
  account_key: string;
  account: string;
  server: string;
  symbol: string;
  floor_server: number;
  cursors: Partial<Record<Tf, number>>;
  /** Only a fully successful timeframe scan advances its head. */
  heads: Partial<Record<Tf, number>>;
  tail_heads: Partial<Record<Tf, number>>;
  gaps: Partial<Record<Tf, Array<{ from: number; to: number }>>>;
  gap_retry_after: Partial<Record<Tf, number>>;
  done: boolean;
}
interface Dependencies {
  terminal: Pick<typeof localTerminal, 'getSnapshot' | 'subscribe' | 'requestReviewBars'>;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  accountKey: (server: string, account: string) => Promise<string>;
  bindTrack?: (identity: Pick<BackfillBody, 'website_user_id' | 'account' | 'server' | 'account_key'> & { clock_sample?: LocalTerminalState['clock_sample'] }, signal: AbortSignal) => Promise<unknown>;
  coverage: (q: { source: string; account_key: string; symbol: string; tf: string; from: number; to: number; quote_sessions?: LocalTerminalState['quote_sessions'] }, signal: AbortSignal) => Promise<{ missing: Array<{ from: number; to: number }> }>;
  upload: (body: BackfillBody, signal: AbortSignal) => Promise<{ ok: boolean }>;
  now: () => number;
  schedule?: (callback: () => void, ms: number) => number;
  cancelSchedule?: (timer: number) => void;
}
export interface BackfillBody {
  website_user_id: string;
  account: string;
  server: string;
  account_key: string;
  symbol: string;
  tf: string;
  from_server: number;
  to_server: number;
  bars: number[][];
}
const FRESH: BackfillState = { phase: 'idle', message: '', locked: false, symbol: '', segments: 0, reachedServer: null, flooredTfs: [], lastUpdated: null, repairUpdated: null };

export class BackfillBars {
  private state: BackfillState = { ...FRESH };
  private listeners = new Set<() => void>();
  private userId = '';
  private generation = 0;
  private controller: AbortController | null = null;
  private session = '';
  private quoteSchedule = '';
  private storageKey = '';
  private checkpoint: Checkpoint | null = null;
  private running: Promise<void> | null = null;
  private timer: number | null = null;
  private paused = false;
  private gapRoundRobin: Partial<Record<Tf, number>> = {};
  constructor(private readonly deps: Dependencies) {
    deps.terminal.subscribe(() => {
      if (this.state.phase === 'idle' || this.paused) return;
      const current = deps.terminal.getSnapshot();
      if (current.phase !== 'connected' || sessionKey(current) !== this.session) this.stop('本机连接或账户已改变，近期行情补齐已停止。');
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<BackfillState>) {
    this.state = { ...this.state, ...patch, locked: false };
    for (const listener of this.listeners) listener();
  }
  private clearTimer() {
    if (this.timer !== null) (this.deps.cancelSchedule ?? ((id) => window.clearTimeout(id)))(this.timer);
    this.timer = null;
  }
  bindUser(userId: string) {
    if (this.userId === userId) return;
    this.paused = false;
    this.stop('');
    this.userId = userId;
    this.state = { ...FRESH };
    for (const listener of this.listeners) listener();
  }
  stop(message = '') {
    this.generation += 1;
    this.clearTimer();
    this.controller?.abort();
    this.controller = null; this.running = null; this.session = ''; this.quoteSchedule = ''; this.storageKey = ''; this.checkpoint = null; this.gapRoundRobin = {};
    this.update({ phase: this.paused ? 'paused' : 'idle', message });
  }
  pause() {
    this.paused = true;
    this.stop('近期行情补齐已暂停。');
  }
  resume() {
    this.paused = false;
    this.update({ phase: 'idle', message: '' });
    return this.start();
  }
  private active(generation: number) {
    return !this.paused && generation === this.generation && this.controller !== null && !this.controller.signal.aborted
      && this.deps.terminal.getSnapshot().phase === 'connected'
      && sessionKey(this.deps.terminal.getSnapshot()) === this.session;
  }
  private busyWithTrade() {
    const t = this.deps.terminal.getSnapshot();
    return t.commands.some((c) => c.account_id === t.account_id && c.server === t.server && !['completed', 'rejected'].includes(c.state));
  }
  private scheduleDelta() {
    this.clearTimer();
    if (!this.active(this.generation)) return;
    this.timer = (this.deps.schedule ?? ((callback, ms) => window.setTimeout(callback, ms)))(() => {
      this.timer = null;
      void this.delta();
    }, DELTA_MS);
  }
  private run(job: () => Promise<void>): Promise<void> {
    if (this.running) return this.running;
    this.clearTimer();
    const requestedGeneration = this.generation;
    const running = Promise.resolve().then(() => {
      if (this.paused || this.generation !== requestedGeneration) return;
      return job();
    });
    this.running = running;
    return running.finally(() => {
      if (this.running !== running) return;
      this.running = null;
      this.scheduleDelta();
    });
  }
  start(): Promise<void> {
    const terminal = this.deps.terminal.getSnapshot();
    if (this.paused || !this.userId || terminal.phase !== 'connected' || !terminal.features.includes('history') || !terminal.history_ready) return Promise.resolve();
    return this.run(async () => {
      const terminal = this.deps.terminal.getSnapshot();
      if (terminal.phase !== 'connected' || !terminal.features.includes('history') || !terminal.history_ready) return;
      this.generation += 1;
      const generation = this.generation;
      this.controller?.abort(); this.controller = new AbortController();
      this.session = sessionKey(terminal);
      this.quoteSchedule = JSON.stringify(terminal.quote_sessions ?? null);
      this.update({ phase: 'initializing', message: '后台补齐近期行情（最近 7 天）…', symbol: terminal.symbol, reachedServer: null, flooredTfs: [] });
      try {
        const accountKey = await this.deps.accountKey(terminal.server, terminal.account_id);
        if (!this.active(generation)) return;
        const sample = terminal.clock_sample;
        await this.deps.bindTrack?.({
          website_user_id: this.userId, account: terminal.account_id, server: terminal.server, account_key: accountKey,
          clock_sample: sample && Math.abs(sample.server_time_ms - this.deps.now()) <= 90000 ? sample : undefined,
        }, this.controller.signal);
        if (!this.active(generation)) return;
        // Old v1 deep-history cursors are intentionally left untouched and never resumed.
        this.storageKey = `syncnote-backfill-v2:${encodeURIComponent(this.userId)}:${accountKey}:${encodeURIComponent(terminal.symbol)}`;
        const nowServer = Math.floor(this.deps.now() / 1000) + terminal.server_offset_sec;
        const floor = Math.max(1, nowServer - RECENT_SECONDS);
        const progress = this.loadProgress(accountKey, terminal, floor, nowServer);
        this.checkpoint = { version: 2, account_key: accountKey, account: terminal.account_id, server: terminal.server,
          symbol: terminal.symbol, floor_server: floor, cursors: {}, ...progress, done: false };
        this.save();
        // Every explicit start/reconnect begins at the current head for ALL periods.
        await this.pump(generation, false);
      } catch (error) {
        if (this.active(generation)) this.update({ phase: 'error', message: `近期行情补齐失败：${error instanceof Error ? error.message : String(error)}` });
      }
    });
  }
  private loadProgress(key: string, terminal: LocalTerminalState, floor: number, nowServer: number) {
    const heads: Partial<Record<Tf, number>> = {};
    const tail_heads: Partial<Record<Tf, number>> = {}, gap_retry_after: Partial<Record<Tf, number>> = {};
    const gaps: Checkpoint['gaps'] = {};
    const progress = { heads, tail_heads, gaps, gap_retry_after };
    try {
      const saved = JSON.parse(this.deps.storage.getItem(this.storageKey) ?? 'null') as Checkpoint | null;
      if (!saved || saved.version !== 2 || saved.account_key !== key || saved.account !== terminal.account_id || saved.server !== terminal.server || saved.symbol !== terminal.symbol) return progress;
      for (const tf of TFS) {
        const head = saved.heads?.[tf];
        if (typeof head === 'number' && Number.isFinite(head) && head >= floor && head <= nowServer) heads[tf] = head;
        const tail = saved.tail_heads?.[tf];
        if (typeof tail === 'number' && Number.isFinite(tail) && tail >= floor && tail <= nowServer) tail_heads[tf] = tail;
        const retry = saved.gap_retry_after?.[tf];
        if (typeof retry === 'number' && Number.isFinite(retry)) gap_retry_after[tf] = retry;
        gaps[tf] = (saved.gaps?.[tf] ?? []).filter((gap) => Number.isFinite(gap.from) && Number.isFinite(gap.to) && gap.to >= gap.from && gap.to >= floor)
          .map((gap) => ({ from: Math.max(floor, gap.from), to: Math.min(nowServer, gap.to) })).filter((gap) => gap.from <= gap.to);
      }
    } catch { /* A bad near-term checkpoint restarts a bounded scan; it cannot start deep history. */ }
    return progress;
  }
  private save() {
    if (this.checkpoint) this.deps.storage.setItem(this.storageKey, JSON.stringify(this.checkpoint));
  }
  private addGap(tf: Tf, from: number, to: number) {
    const cp = this.checkpoint!, period = TF_SECONDS[tf];
    from = Math.ceil(from / period) * period; to = Math.floor(to / period) * period;
    if (to < from) return;
    const all = [...(cp.gaps[tf] ?? []), { from, to }].sort((a, b) => a.from - b.from);
    const merged: Array<{ from: number; to: number }> = [];
    for (const gap of all) {
      const last = merged.at(-1);
      if (last && gap.from <= last.to + period) last.to = Math.max(last.to, gap.to);
      else merged.push({ ...gap });
    }
    cp.gaps[tf] = merged;
    cp.gap_retry_after[tf] ??= this.deps.now() + GAP_RETRY_MS;
  }
  private confirmSpan(tf: Tf, from: number, to: number) {
    const cp = this.checkpoint!, period = TF_SECONDS[tf];
    cp.gaps[tf] = (cp.gaps[tf] ?? []).flatMap((gap) => {
      if (gap.to < from || gap.from > to) return [gap];
      const rest: Array<{ from: number; to: number }> = [];
      if (gap.from < from) rest.push({ from: gap.from, to: from - period });
      if (gap.to > to) rest.push({ from: to + period, to: gap.to });
      return rest;
    }).filter((gap) => gap.from <= gap.to);
    if (!cp.gaps[tf]?.length) delete cp.gap_retry_after[tf];
  }
  private reconcileCoverage(tf: Tf, from: number, to: number, missing: Array<{ from: number; to: number }>) {
    const period = TF_SECONDS[tf];
    // Coverage uses inclusive seconds; only candle-opening timestamps are possible gaps.
    const holes = missing
      .map(gap => ({ from: Math.ceil(Math.max(from, gap.from) / period) * period,
        to: Math.floor(Math.min(to, gap.to) / period) * period }))
      .filter(gap => Number.isFinite(gap.from) && Number.isFinite(gap.to) && gap.to >= gap.from)
      .sort((a, b) => a.from - b.from);
    let cursor = Math.ceil(from / period) * period;
    for (const gap of holes) {
      if (cursor < gap.from) this.confirmSpan(tf, cursor, gap.from - period);
      cursor = Math.max(cursor, gap.to + period);
    }
    if (cursor <= to) this.confirmSpan(tf, cursor, to);
    return holes.at(-1);
  }
  private coverage(tf: Tf, from: number, to: number, signal: AbortSignal) {
    const cp = this.checkpoint!;
    const terminal = this.deps.terminal.getSnapshot();
    return this.deps.coverage({ source: 'srv:' + cp.server.trim(), account_key: cp.account_key,
      symbol: cp.symbol, tf, from, to, quote_sessions: terminal.symbol === cp.symbol ? terminal.quote_sessions : null }, signal);
  }
  private confirmRows(tf: Tf, from: number, to: number, rows: number[][], target: number) {
    const cp = this.checkpoint!, period = TF_SECONDS[tf];
    this.addGap(tf, from, to);
    const times = [...new Set(rows.map((row) => row[0]))].sort((a, b) => a - b);
    const spans: Array<{ from: number; to: number }> = [];
    for (const time of times) {
      const last = spans.at(-1);
      if (last && time === last.to + period) last.to = time;
      else spans.push({ from: time, to: time });
    }
    for (const span of spans) this.confirmSpan(tf, span.from, span.to);
    const tail = spans.at(-1);
    if (tail?.to === target && tail.from <= target - 2 * period) cp.tail_heads[tf] = Math.max(cp.tail_heads[tf] ?? 0, target);
  }
  private promoteConfirmedHead(tf: Tf, floor: number) {
    const cp = this.checkpoint!, tail = cp.tail_heads[tf];
    if (tail === undefined) return;
    const period = TF_SECONDS[tf];
    const begin = Math.max(floor, cp.heads[tf] !== undefined ? cp.heads[tf]! - 2 * period : tail - (MAX_BARS - 1) * period);
    if (!(cp.gaps[tf] ?? []).some((gap) => gap.to >= begin && gap.from <= tail)) cp.heads[tf] = Math.max(cp.heads[tf] ?? 0, tail);
  }
  private async pump(generation: number, delta: boolean) {
    const cp = this.checkpoint!;
    const signal = this.controller!.signal;
    const terminal = this.deps.terminal.getSnapshot();
    const nowServer = Math.floor(this.deps.now() / 1000) + terminal.server_offset_sec;
    const recentFloor = Math.max(1, nowServer - RECENT_SECONDS);
    const targets: Partial<Record<Tf, number>> = {}, floors: Partial<Record<Tf, number>> = {};
    const promotionFloors: Partial<Record<Tf, number>> = {};
    const failed = new Set<Tf>(), empty = new Set<Tf>();
    let tradePaused = false;
    cp.floor_server = recentFloor; cp.done = false;
    for (const tf of TFS) {
      const period = TF_SECONDS[tf];
      targets[tf] = Math.floor(nowServer / period) * period - period;
      const tail = cp.tail_heads[tf] ?? cp.heads[tf];
      floors[tf] = delta ? Math.max(recentFloor, (tail ?? targets[tf]!) - 2 * period) : recentFloor;
      // A new connection can establish its current head after one verified tail
      // window. A resumed connection must first bridge its previous head too.
      promotionFloors[tf] = cp.heads[tf] !== undefined ? Math.max(recentFloor, cp.heads[tf]! - 2 * period)
        : Math.max(recentFloor, targets[tf]! - (MAX_BARS - 1) * period);
      const firstBar = Math.ceil(recentFloor / period) * period;
      cp.gaps[tf] = (cp.gaps[tf] ?? []).filter(gap => gap.to >= firstBar)
        .map(gap => ({ from: Math.max(firstBar, gap.from), to: gap.to }));
      this.addGap(tf, delta ? floors[tf]! : promotionFloors[tf]!, targets[tf]!);
      cp.cursors[tf] = targets[tf];
    }
    this.save();
    // One segment per timeframe per round: an M1 backlog cannot starve M5/M15/H1.
    while (this.active(generation)) {
      let progressed = false;
      for (const tf of TFS) {
        if (failed.has(tf) || cp.cursors[tf]! < floors[tf]!) continue;
        if (this.busyWithTrade()) { tradePaused = true; break; }
        progressed = true;
        const period = TF_SECONDS[tf], floor = floors[tf]!;
        const to = Math.floor(cp.cursors[tf]! / period) * period;
        const from = Math.max(to - (MAX_BARS - 1) * period, Math.ceil(floor / period) * period);
        if (to < from) { cp.cursors[tf] = floor - 1; continue; }
        try {
          const coverage = await this.coverage(tf, from, to, signal);
          if (!this.active(generation)) return;
          const hole = this.reconcileCoverage(tf, from, to, coverage.missing);
          if (!hole) {
            if (to === targets[tf] && from <= to - 2 * period) cp.tail_heads[tf] = Math.max(cp.tail_heads[tf] ?? 0, to);
            cp.cursors[tf] = from - period;
            this.promoteConfirmedHead(tf, recentFloor); this.save(); continue;
          }
          const { from: fetchFrom, to: fetchTo } = hole;
          const page = await this.deps.terminal.requestReviewBars(cp.symbol, TF_WIRE[tf], { from_server: fetchFrom, to_server: fetchTo }, signal);
          if (!this.active(generation)) return;
          if (page.symbol !== cp.symbol || page.tf !== TF_WIRE[tf] || page.time_basis !== 'broker_server'
            || page.range?.from_server !== fetchFrom || page.range?.to_server !== fetchTo) throw new Error('EA 返回的行情范围不一致');
          const rows = (page.bars || []).filter((row) => Array.isArray(row) && row.length >= 5 && row.slice(0, 5).every(Number.isFinite)
            && row[0] % period === 0 && row[0] >= Math.floor(fetchFrom / period) * period && row[0] <= fetchTo && row[0] + period <= nowServer);
          if (rows.length) {
            const ack = await this.deps.upload({ website_user_id: this.userId, account: cp.account, server: cp.server, account_key: cp.account_key,
              symbol: cp.symbol, tf, from_server: fetchFrom, to_server: fetchTo, bars: rows.map((row) => row.slice(0, 6)) }, signal);
            if (!this.active(generation)) return;
            if (!ack.ok) throw new Error('服务器未确认行情入库');
            this.confirmRows(tf, fetchFrom, fetchTo, rows, targets[tf]!);
            this.update({ segments: this.state.segments + 1, lastUpdated: this.deps.now() });
          } else {
            empty.add(tf);
            this.addGap(tf, fetchFrom, fetchTo);
          }
          const next = fetchFrom - period;
          cp.cursors[tf] = next;
          this.promoteConfirmedHead(tf, recentFloor);
          this.save();
          this.update({ reachedServer: next, message: `后台补齐近期行情…（${cp.symbol} ${tf}）` });
        } catch (error) {
          if (!this.active(generation)) return;
          failed.add(tf);
          this.addGap(tf, delta ? from : floor, to);
          this.update({ message: `近期 ${tf} 行情稍后重试：${error instanceof Error ? error.message : String(error)}` });
        }
      }
      if (tradePaused || !progressed) break;
    }
    if (!this.active(generation)) return;
    for (const tf of TFS) {
      this.promoteConfirmedHead(tf, recentFloor);
    }
    const partial = tradePaused || failed.size > 0 || empty.size > 0 || TFS.some((tf) => cp.gaps[tf]?.length);
    cp.done = !partial; this.save();
    this.update({ phase: partial ? 'partial_ready' : 'ready', message: tradePaused ? '未决交易指令优先，后台补齐近期行情已让路。'
      : partial ? '近 7 天仍有未确认的 K 线时段，可能包含休市或 MT5 暂未返回的历史。后台会继续检查。' : '近期行情已补齐，后台每分钟检查新增 K 线。' });
  }
  /** Old unproven spans get one bounded probe per timeframe every ten minutes. */
  private async repairGaps(generation: number) {
    const cp = this.checkpoint!, signal = this.controller!.signal;
    const nowServer = Math.floor(this.deps.now() / 1000) + this.deps.terminal.getSnapshot().server_offset_sec;
    for (const tf of TFS) {
      if (!this.active(generation) || this.busyWithTrade()) return;
      if ((cp.gap_retry_after[tf] ?? 0) > this.deps.now()) continue;
      const gaps = [...(cp.gaps[tf] ?? [])].sort((a, b) => b.to - a.to);
      if (!gaps.length) continue;
      const index = (this.gapRoundRobin[tf] ?? 0) % gaps.length;
      const gap = gaps[index];
      this.gapRoundRobin[tf] = index + 1;
      const period = TF_SECONDS[tf], target = Math.floor(nowServer / period) * period - period;
      const to = Math.min(gap.to, target);
      const from = Math.max(gap.from, to - (MAX_BARS - 1) * period);
      cp.gap_retry_after[tf] = this.deps.now() + GAP_RETRY_MS;
      try {
        const coverage = await this.coverage(tf, from, to, signal);
        if (!this.active(generation)) return;
        const hole = this.reconcileCoverage(tf, from, to, coverage.missing);
        if (hole) {
          const { from, to } = hole;
          const page = await this.deps.terminal.requestReviewBars(cp.symbol, TF_WIRE[tf], { from_server: from, to_server: to }, signal);
          if (!this.active(generation)) return;
          if (page.symbol !== cp.symbol || page.tf !== TF_WIRE[tf] || page.time_basis !== 'broker_server'
            || page.range?.from_server !== from || page.range?.to_server !== to) throw new Error('EA 返回的行情范围不一致');
          const rows = (page.bars || []).filter((row) => Array.isArray(row) && row.length >= 5 && row.slice(0, 5).every(Number.isFinite)
            && row[0] % period === 0 && row[0] >= from && row[0] <= to && row[0] + period <= nowServer);
          if (rows.length) {
            const ack = await this.deps.upload({ website_user_id: this.userId, account: cp.account, server: cp.server, account_key: cp.account_key,
              symbol: cp.symbol, tf, from_server: from, to_server: to, bars: rows.map((row) => row.slice(0, 6)) }, signal);
            if (!this.active(generation)) return;
            if (!ack.ok) throw new Error('服务器未确认行情入库');
            this.confirmRows(tf, from, to, rows, target);
            this.update({ segments: this.state.segments + 1, lastUpdated: this.deps.now(), repairUpdated: this.deps.now() });
          }
        }
        this.promoteConfirmedHead(tf, cp.floor_server);
      } catch { if (!this.active(generation)) return; /* Keep the gap; no fabricated empty coverage. */ }
      this.save();
    }
    if (!this.active(generation)) return;
    cp.done = !TFS.some((tf) => cp.gaps[tf]?.length);
    this.save();
    this.update({ phase: cp.done ? 'ready' : 'partial_ready', message: cp.done ? '近期行情已补齐，后台每分钟检查新增 K 线。'
      : '近 7 天仍有未确认的 K 线时段，可能包含休市。较早时段每 10 分钟分段复查。' });
  }
  delta(): Promise<void> {
    if (this.paused) return Promise.resolve();
    if (!this.checkpoint || !this.active(this.generation)) return Promise.resolve();
    if (this.quoteSchedule !== JSON.stringify(this.deps.terminal.getSnapshot().quote_sessions ?? null)) return this.start();
    return this.run(async () => {
      const generation = this.generation;
      try {
        await this.pump(generation, true);
        if (this.active(generation)) await this.repairGaps(generation);
      }
      catch (error) {
        if (this.active(generation)) this.update({ phase: 'partial_ready', message: `近期行情稍后重试：${error instanceof Error ? error.message : String(error)}` });
      }
    });
  }
}

async function postJSON(url: string, body: unknown, signal: AbortSignal) {
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
  return data;
}
async function getJSON(url: string, signal: AbortSignal) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
  return data;
}

export const backfillBars = new BackfillBars({
  terminal: localTerminal,
  storage: { getItem: (k) => window.localStorage.getItem(k), setItem: (k, v) => window.localStorage.setItem(k, v) },
  accountKey: historyAccountKey,
  now: () => Date.now(),
  bindTrack: (body, signal) => postJSON('/api/market/bind-track', body, signal),
  coverage: (q, signal) => q.quote_sessions ? postJSON('/api/market/coverage', q, signal)
    : getJSON('/api/market/coverage?' + new URLSearchParams({
      source: q.source, symbol: q.symbol, tf: q.tf, from: String(q.from), to: String(q.to),
    }), signal),
  upload: (body, signal) => postJSON('/api/market/backfill', body, signal),
});
export const useBackfillBars = () => useSyncExternalStore(backfillBars.subscribe, backfillBars.getSnapshot);
