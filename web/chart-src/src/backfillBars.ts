import { useSyncExternalStore } from 'react';
import { localTerminal, type LocalTerminalState } from './localTerminal';
import { historyAccountKey } from './localHistorySync';

/**
 * 历史 K 线连续回填 → 服务器共享数据轨道（bars 表，按券商 source 全局共享）。
 *
 * 首填是阻塞式初始化,只锁"读轨道的功能"(复盘/轨道图),不锁下单和实时看盘。
 * 做法:四周期从最新往回,每段先查 coverage 跳过已填(同券商复用别人填的),
 * 没填才经本机 WS 拉 ≤2000 根再传服务器。填到最早交易-100根 或 5 年上限 或
 * EA 给不出更早(HISTORY_UNAVAILABLE)为止。首填完成后转轻量 delta 增量。
 *
 * 断点存 localStorage,关网页暂停、重开续填。读请求与复盘历史读互斥(localTerminal
 * 串行约束),所以各段排队。下单指令优先:有未完成指令就让路。
 */

export type BackfillPhase = 'idle' | 'initializing' | 'ready' | 'partial_ready' | 'error';
export interface BackfillState {
  phase: BackfillPhase;
  message: string;
  /** 读轨道功能是否该锁:仅 initializing 阶段锁。 */
  locked: boolean;
  symbol: string;
  /** 已填入的段数(本会话累计,含跳过的已覆盖段)。 */
  segments: number;
  /** 当前回填游标已到的券商墙钟秒(越小=越早)。 */
  reachedServer: number | null;
  /** 四周期各自是否已到可得边界(EA 给不出更早)。 */
  flooredTfs: string[];
}

type Tf = 'M1' | 'M5' | 'M15' | 'H1';
const TFS: Tf[] = ['M1', 'M5', 'M15', 'H1'];
const TF_SECONDS: Record<Tf, number> = { M1: 60, M5: 300, M15: 900, H1: 3600 };
const TF_WIRE: Record<Tf, string> = { M1: '1m', M5: '5m', M15: '15m', H1: '1h' };
const MAX_BARS = 2000;        // EA 单请求硬上限
const FLOOR_100 = 100;        // 最早交易再往前留的根数
const FIVE_YEARS = 5 * 365 * 86400;
const sessionKey = (s: LocalTerminalState) => [s.instance_id, s.account_id, s.server, s.epoch].join('\n');

interface Checkpoint {
  version: 1;
  account_key: string;
  account: string;
  server: string;
  symbol: string;
  floor_server: number;       // 回填下界(最早交易-100根 与 5年 取较晚)
  /** 每周期当前游标(已填到的最早墙钟秒);到 floor 或遇边界即完成。 */
  cursors: Partial<Record<Tf, number>>;
  floored: Tf[];              // 已到可得边界的周期
  done: boolean;
}

interface Dependencies {
  terminal: Pick<typeof localTerminal, 'getSnapshot' | 'subscribe' | 'requestReviewBars'>;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  accountKey: (server: string, account: string) => Promise<string>;
  coverage: (q: { source?: string; symbol: string; tf: string; from: number; to: number }, signal: AbortSignal) => Promise<{ missing: Array<{ from: number; to: number }> }>;
  earliest: (symbol: string, signal: AbortSignal) => Promise<{ earliest_server: number | null }>;
  upload: (body: BackfillBody, signal: AbortSignal) => Promise<{ ok: boolean }>;
  now: () => number;
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

const FRESH: BackfillState = { phase: 'idle', message: '', locked: false, symbol: '', segments: 0, reachedServer: null, flooredTfs: [] };

export class BackfillBars {
  private state: BackfillState = { ...FRESH };
  private listeners = new Set<() => void>();
  private userId = '';
  private generation = 0;
  private controller: AbortController | null = null;
  private session = '';
  private storageKey = '';
  private checkpoint: Checkpoint | null = null;
  /** 每个周期的边界误判重试次数:序列没加载好时退避重试,不要一次就判到底。 */
  private retries = new Map<Tf, number>();
  constructor(private readonly deps: Dependencies) {
    deps.terminal.subscribe(() => {
      if (this.state.phase === 'idle') return;
      const current = deps.terminal.getSnapshot();
      if (current.phase !== 'connected' || sessionKey(current) !== this.session) this.stop('本机连接或账户已改变,行情回填已暂停。');
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<BackfillState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  bindUser(userId: string) {
    if (this.userId === userId) return;
    this.stop('');
    this.userId = userId;
    this.state = { ...FRESH };
    for (const listener of this.listeners) listener();
  }
  stop(message = '') {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.session = '';
    this.storageKey = '';
    this.checkpoint = null;
    this.update({ phase: 'idle', locked: false, message });
  }
  private active(generation: number) {
    return generation === this.generation && this.controller !== null && !this.controller.signal.aborted
      && this.deps.terminal.getSnapshot().phase === 'connected'
      && sessionKey(this.deps.terminal.getSnapshot()) === this.session;
  }
  private busyWithTrade() {
    const t = this.deps.terminal.getSnapshot();
    return t.commands.some((c) => c.account_id === t.account_id && c.server === t.server && ['sending', 'received', 'submitted'].includes(c.state));
  }
  async start() {
    const terminal = this.deps.terminal.getSnapshot();
    if (!this.userId || terminal.phase !== 'connected' || !terminal.features.includes('history') || !terminal.history_ready) return;
    if (this.state.phase === 'initializing') return;
    this.generation += 1;
    const generation = this.generation;
    this.controller = new AbortController();
    this.session = sessionKey(terminal);
    const signal = this.controller.signal;
    const symbol = terminal.symbol;
    this.update({ phase: 'initializing', locked: true, message: '正在确保行情数据完整,复盘功能稍后可用…', symbol, segments: 0, reachedServer: null, flooredTfs: [] });
    try {
      const accountKey = await this.deps.accountKey(terminal.server, terminal.account_id);
      if (!this.active(generation)) return;
      this.storageKey = `syncnote-backfill-v1:${encodeURIComponent(this.userId)}:${accountKey}:${encodeURIComponent(symbol)}`;
      this.checkpoint = this.loadCheckpoint(accountKey, terminal, symbol);
      if (!this.checkpoint) {
        const nowServer = Math.floor(this.deps.now() / 1000) + terminal.server_offset_sec;
        const resp = await this.deps.earliest(symbol, signal);
        if (!this.active(generation)) return;
        const earliest = resp.earliest_server && resp.earliest_server > 0 ? resp.earliest_server : nowServer - FIVE_YEARS;
        const floor = Math.max(earliest - FLOOR_100 * TF_SECONDS.M1, nowServer - FIVE_YEARS, 1);
        this.checkpoint = { version: 1, account_key: accountKey, account: terminal.account_id, server: terminal.server, symbol,
          floor_server: floor, cursors: { M1: nowServer, M5: nowServer, M15: nowServer, H1: nowServer }, floored: [], done: false };
        this.save();
      }
      await this.pump(generation);
    } catch (error) {
      if (this.active(generation)) this.update({ phase: 'error', locked: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  private loadCheckpoint(accountKey: string, terminal: LocalTerminalState, symbol: string): Checkpoint | null {
    const saved = this.deps.storage.getItem(this.storageKey);
    if (!saved) return null;
    try {
      const c = JSON.parse(saved) as Checkpoint;
      if (c.version !== 1 || c.account_key !== accountKey || c.account !== terminal.account_id || c.server !== terminal.server || c.symbol !== symbol) return null;
      if (!Number.isFinite(c.floor_server) || typeof c.cursors !== 'object') return null;
      return c;
    } catch { return null; }
  }
  private save() {
    if (this.checkpoint) this.deps.storage.setItem(this.storageKey, JSON.stringify(this.checkpoint));
  }
  private async pump(generation: number) {
    const cp = this.checkpoint!;
    const signal = this.controller!.signal;
    const source = undefined; // 服务器按登录用户的 feed 解析 source,前端不传
    while (this.active(generation)) {
      // 下单优先:有未完成指令就暂停让路,2 秒后重试。
      if (this.busyWithTrade()) {
        this.update({ message: '本机交易指令优先,行情回填已暂停…' });
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      // 选一个还没填完的周期(到 floor 或已 floored 的跳过)。四周期串行。
      const tf = TFS.find((t) => !cp.floored.includes(t) && (cp.cursors[t] ?? cp.floor_server) > cp.floor_server);
      if (!tf) { this.finish(generation); return; }
      const period = TF_SECONDS[tf];
      const to = cp.cursors[tf]!;
      const from = Math.max(to - MAX_BARS * period, cp.floor_server);
      // 先查这段有没有被(自己或同券商别人)填过,跳过已覆盖。可能有多个空洞:
      // 本轮只处理最靠右的洞,游标前移到该洞左界(不是整段 from),左侧剩余的洞下一轮再处理,不丢段。
      let fetchFrom = from, fetchTo = to, advanceTo = from;
      try {
        const cov = await this.deps.coverage({ source, symbol: cp.symbol, tf, from, to }, signal);
        if (!this.active(generation)) return;
        const holes = (cov.missing || []).filter((h) => h.to > h.from).sort((a, b) => b.to - a.to);
        if (!holes.length) { cp.cursors[tf] = from; this.save(); this.update({ reachedServer: from }); continue; } // 整段已覆盖
        fetchTo = holes[0].to; fetchFrom = Math.max(holes[0].from, from);
        advanceTo = fetchFrom; // 游标停在本轮处理的洞的左界,保留左侧其余洞
      } catch { /* coverage 查询失败不致命:退回按整段拉,游标推到 from */ }
      // 经本机 WS 拉这段 K 线(≤2000 根,串行)。
      try {
        const page = await this.deps.terminal.requestReviewBars(cp.symbol, TF_WIRE[tf], { from_server: fetchFrom, to_server: fetchTo }, signal);
        if (!this.active(generation)) return;
        const rows = (page.bars || []).filter((r) => Array.isArray(r) && r.length >= 5 && r.slice(0, 5).every((v) => Number.isFinite(v)));
        if (rows.length) {
          await this.deps.upload({ website_user_id: this.userId, account: cp.account, server: cp.server, account_key: cp.account_key,
            symbol: cp.symbol, tf, from_server: fetchFrom, to_server: fetchTo, bars: rows.map((r) => r.slice(0, 6)) }, signal);
          if (!this.active(generation)) return;
          this.update({ segments: this.state.segments + 1 });
        }
        // 游标前移到 advanceTo(本轮处理的洞左界;coverage 失败时 = from)。
        // 防卡:必须严格小于当前 to,否则强制退到 from,保证单调递减、不原地打转。
        const next = advanceTo < to ? advanceTo : from;
        cp.cursors[tf] = next; this.retries.delete(tf); this.save();
        this.update({ reachedServer: next, message: `正在确保行情数据完整…(${cp.symbol} ${tf},已到 ${new Date(next * 1000).toISOString().slice(0, 10)})` });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // 「整个窗口都早于可得历史」才算到底(EA 用 SERIES_FIRSTDATE 判定)。
        if (/starts later than|reached available floor|no earlier history/i.test(msg)) {
          if (!cp.floored.includes(tf)) cp.floored.push(tf);
          this.save();
          this.update({ flooredTfs: [...cp.floored] });
        } else if (/HISTORY_UNAVAILABLE|not ready|does not cover|unavailable/i.test(msg)) {
          // 序列还没加载好 / 旧版 EA 的边界误判:退避重试几次再放弃,不要一次就判到底。
          const attempts = (this.retries.get(tf) ?? 0) + 1;
          this.retries.set(tf, attempts);
          if (attempts > 5) {
            if (!cp.floored.includes(tf)) cp.floored.push(tf);
            this.save();
            this.update({ flooredTfs: [...cp.floored] });
          } else {
            this.update({ message: `等待 MT5 加载 ${tf} 历史(第 ${attempts} 次)…` });
            await new Promise((r) => setTimeout(r, 3000));
            if (!this.active(generation)) return;
          }
        } else {
          this.update({ phase: 'error', locked: false, message: '行情回填出错,可重试:' + msg });
          return;
        }
      }
    }
  }
  private finish(generation: number) {
    const cp = this.checkpoint!;
    cp.done = true; this.save();
    if (!this.active(generation)) return;
    const partial = cp.floored.length > 0;
    this.update({
      phase: partial ? 'partial_ready' : 'ready', locked: false,
      message: partial ? '行情数据已就绪;更早的历史需要在 MT5 加载后重新回填。' : '行情数据已完整,复盘功能可用。',
    });
  }
  /** 首填完成后的轻量增量:把游标顶端补到当前最新(不锁功能)。 */
  async delta() {
    const terminal = this.deps.terminal.getSnapshot();
    if (this.state.phase !== 'ready' && this.state.phase !== 'partial_ready') return;
    if (!this.checkpoint || terminal.phase !== 'connected') return;
    // delta 的实现与 pump 对称:把 cursors 的"顶端"从已记录的 to 推到当前最新。
    // 首版先依赖实时推送 + 复盘回填覆盖近端;delta 的完整实现留待真机验证后补。
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
  coverage: (q, signal) => getJSON(`/api/market/coverage?symbol=${encodeURIComponent(q.symbol)}&tf=${encodeURIComponent(q.tf)}&from=${q.from}&to=${q.to}`, signal),
  earliest: (symbol, signal) => getJSON(`/api/market/earliest?symbol=${encodeURIComponent(symbol)}`, signal),
  upload: (body, signal) => postJSON('/api/market/backfill', body, signal),
});
export const useBackfillBars = () => useSyncExternalStore(backfillBars.subscribe, backfillBars.getSnapshot);
