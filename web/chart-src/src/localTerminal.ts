import { useSyncExternalStore } from 'react';

export type LocalPhase = 'disconnected' | 'connecting' | 'pairing' | 'confirming' | 'connected' | 'error';
export interface LocalCommand {
  command_id: string;
  action: string;
  state: string;
  created: number;
  account_id: string;
  server: string;
  error?: string;
  retcode?: number;
  order?: string;
  deal?: string;
  volume?: number;
  partial?: boolean;
}
export interface LocalTerminalState {
  phase: LocalPhase;
  error: string;
  instance_id: string;
  account_id: string;
  server: string;
  epoch: string;
  symbol: string;
  read_only: boolean;
  demo: boolean;
  /** 对冲账户：false = 净额账户（持仓合并，归属无法证明）。 */
  hedging: boolean;
  /** 净额账户下 EA 是否允许平仓/改单。 */
  netting_manage: boolean;
  /** EA 明确允许当前实盘账户交易；不限额模式不依赖旧实盘开关或额度。 */
  real_trading: boolean;
  /** EA 开了「配对后无任何限制」（InpUnrestricted），额度与开关都不检查。 */
  unrestricted?: boolean;
  /** 配对后不受账户类型和手数 / 敞口 / 每日额度限制；不授予净额持仓管理。 */
  quota_unrestricted?: boolean;
  /** 实盘不限额（InpRealNoCaps）。 */
  real_no_caps?: boolean;
  /** EA 报告的拦截原因：journal / risk / account / margin_mode / allow_trading / real_not_allowed / caps。 */
  block_reason?: string;
  capabilities: string[];
  product: string;
  features: string[];
  server_offset_sec: number;
  latency: number | null;
  account: Record<string, any>;
  tick: { symbol?: string; bid: number; ask: number; time: number } | null;
  positions: any[];
  orders: any[];
  bars: Record<string, number[][]>;
  history_ready: boolean;
  commands: LocalCommand[];
  revision: number;
}

export interface NoteHistoryPage {
  type: 'history';
  request_id: string;
  account_id: string;
  account_key: string;
  server: string;
  epoch: string;
  range: { from_server: number; to_server: number };
  deals: Array<Record<string, unknown>>;
  next_cursor: string;
  has_more: boolean;
  through_server: number;
  time_basis: 'broker_server';
  server_offset_sec: number;
}
export interface NoteReviewBars {
  type: 'bars';
  request_id: string;
  symbol: string;
  tf: string;
  range: { from_server: number; to_server: number };
  time_basis: 'broker_server';
  bars: number[][];
}

const freshState = (): LocalTerminalState => ({
  phase: 'disconnected', error: '', instance_id: '', account_id: '', server: '', epoch: '',
  symbol: 'XAUUSD', read_only: true, demo: false, hedging: false, netting_manage: false, real_trading: false, capabilities: [], product: '', features: [], server_offset_sec: 0,
  latency: null, account: {}, tick: null,
  positions: [], orders: [], bars: {}, history_ready: false, commands: [], revision: 0,
});
const TF_SECONDS: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 };
/** 初次连上时每个周期预取多少根:EA 的 range 模式一次最多 2000 个周期槽。 */
// 留 10 根余量:EA 会按周期对齐起点,正好 2000 槽时可能多出一根被判超限。
const HISTORY_SLOTS = 1990;
const terminalStates = new Set(['completed', 'rejected']);
const unresolvedStates = new Set(['sending', 'received', 'submitted', 'uncertain', 'not_found']);
const tfKeys = new Set(['1m', '5m', '15m', '1h']);

class EaBarsError extends Error {
  constructor(readonly code: string, readonly detail: string) { super(code); }
}

/** 显示与发送共用 EA 的账户授权，避免不限额模式仍被旧网页门禁拦住。 */
export function localTradeAccess(state: LocalTerminalState) {
  const accountAllowed = state.demo || state.real_trading || state.unrestricted === true || state.quota_unrestricted === true;
  const canManage = state.hedging || state.netting_manage || state.unrestricted === true;
  const unresolved = state.commands.some((command) => command.account_id === state.account_id && command.server === state.server && unresolvedStates.has(command.state));
  const blockText: Record<string, string> = {
    journal: 'EA 写不了下单日志：检查 MQL5/Files 是否被占用或有权限限制',
    risk: 'EA 的风控账本打不开：检查是否在多个图表挂了同一账户的 SyncTrade；保留下单日志，先核对未完成指令',
    account: '账户信息还没稳定（MT5 正在切换账户），等几秒或重新挂载 EA',
    margin_mode: '不支持的保证金模式，EA 只接对冲/净额/交易所账户',
    allow_trading: '当前 EA 配置为只读，请在 MT5 核对交易授权',
    real_not_allowed: '旧版 EA 仍在限制实盘账户，请更新并重新加载 EA',
    caps: '当前 EA 仍启用了旧版额度限制，请更新并重新加载 EA',
  };
  const lockedReason = state.phase !== 'connected' ? ''
    : state.read_only ? '已连接，但 EA 不接单：' + (blockText[state.block_reason ?? ''] ?? '请在 MT5 核对本机授权与 EA 状态')
      : !accountAllowed ? '已连接，但 EA 未授权当前账户交易，请核对本机授权与 EA 版本'
        : unresolved ? '已连接，但还有未确认的指令，先核对结果再下单' : '';
  return {
    accountAllowed, canManage, lockedReason,
    realTrading: accountAllowed && !state.demo,
    enabled: state.phase === 'connected' && !state.read_only && accountAllowed && !unresolved,
  };
}

/** One connection per page. Credentials stay in RAM; trade writes never retry or use the cloud. */
export class LocalTerminal {
  private state = freshState();
  private token = '';
  private socket: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private heartbeat: number | null = null;
  private lastMessage = 0;
  private pingSent = 0;
  private clockOffsetMs = 0;
  private historyQueue: string[] = [];
  private pendingHistory: { id: string; tf: string; timer: number } | null = null;
  private deadlines = new Map<string, number>();
  private noteReads = new Map<string, { resolve: (page: NoteHistoryPage) => void; reject: (error: Error) => void; cleanup: () => void }>();
  private reviewReads = new Map<string, { resolve: (page: NoteReviewBars) => void; reject: (error: Error) => void; cleanup: () => void }>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<LocalTerminalState>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener();
  }
  connect() {
    this.disconnect();
    if (!window.isSecureContext) {
      this.update({ phase: 'error', error: '请使用 HTTPS 网站连接本机 MT5；本地开发可使用 localhost。' });
      return;
    }
    this.update({ phase: 'connecting', error: '' });
    try {
      const socket = new WebSocket('ws://127.0.0.1:18765/ws', 'tongpin-local.v1');
      this.socket = socket;
      this.lastMessage = Date.now();
      socket.onmessage = (event) => {
        if (this.socket !== socket || typeof event.data !== 'string' || event.data.length > 1024 * 1024) return;
        this.lastMessage = Date.now();
        try { this.receive(JSON.parse(event.data)); } catch { this.update({ error: 'EA 返回了无法识别的数据，请核对源码版本。' }); }
      };
      socket.onerror = () => {
        if (this.socket === socket) this.update({ error: '未能连接本机 EA。请检查 EA 已运行、来源配置和浏览器的本机网络权限。' });
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        const message = this.state.error || '本机连接已断开。交易已停用；重新连接后请核查未完成指令。';
        this.disconnect();
        this.update({ phase: 'error', error: message });
      };
      this.heartbeat = window.setInterval(() => {
        const timeout = this.state.phase === 'pairing' || this.state.phase === 'confirming' ? 125000 : 15000;
        if (Date.now() - this.lastMessage > timeout) {
          this.disconnect();
          this.update({ phase: 'error', error: 'EA 长时间未响应，已停止交易；请重新连接并核查指令结果。' });
        } else if (this.state.phase === 'connected') {
          this.pingSent = performance.now();
          this.send({ type: 'ping' });
        }
      }, 3000);
    } catch {
      this.disconnect();
      this.update({ phase: 'error', error: '浏览器阻止了本机连接，请检查本机网络权限并使用受支持的 Chrome 或 Edge。' });
    }
  }
  disconnect() {
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close();
    this.token = '';
    this.clockOffsetMs = 0;
    this.historyQueue = [];
    if (this.pendingHistory) window.clearTimeout(this.pendingHistory.timer);
    this.pendingHistory = null;
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const timer of this.deadlines.values()) window.clearTimeout(timer);
    this.deadlines.clear();
    for (const read of this.noteReads.values()) {
      read.cleanup();
      read.reject(new Error('本机连接已结束，笔记同步已暂停。'));
    }
    this.noteReads.clear();
    for (const read of this.reviewReads.values()) {
      read.cleanup();
      read.reject(new Error('本机连接已结束，复盘同步已暂停。'));
    }
    this.reviewReads.clear();
    const commands = this.state.commands.map((command) => terminalStates.has(command.state) ? command : {
      ...command, state: 'uncertain', error: '连接已结束，执行结果待核实；不会自动重发。',
    });
    this.state = { ...freshState(), revision: this.state.revision };
    this.update({ commands });
  }
  pair(code: string) {
    if (this.state.phase !== 'pairing' || !/^\d{8}$/.test(code)) throw new Error('请输入 EA 图表显示的 8 位配对码。');
    this.send({ type: 'pair', code }, false);
  }
  private send(message: Record<string, unknown>, authenticate = true) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('本机 EA 未连接。');
    if (authenticate && (!this.token || this.state.phase !== 'connected')) throw new Error('请先完成本机配对。');
    this.socket.send(JSON.stringify({ ...message, ...(authenticate ? this.auth() : {}) }));
  }
  private auth() {
    return { token: this.token, account_id: this.state.account_id, server: this.state.server, epoch: this.state.epoch };
  }
  private nextHistory() {
    if (this.pendingHistory) window.clearTimeout(this.pendingHistory.timer);
    this.pendingHistory = null;
    const tf = this.historyQueue.shift();
    if (!tf) { this.update({ history_ready: true }); return; }
    const id = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      this.update({ error: `本机 ${tf} 历史加载超时，继续加载其他周期；可在 MT5 加载历史后重新连接。` });
      this.nextHistory();
    }, 10000);
    this.pendingHistory = { id, tf, timer };
    // 原来只取 400 根（1m 才 6 小时），指标和复盘都不够用。
    // 改成 range 模式一次取满 2000 个周期槽：1m≈33h、5m≈7天、15m≈20天、1h≈83天。
    const period = TF_SECONDS[tf] ?? 60;
    const to = Math.floor(Date.now() / 1000) + (this.state.server_offset_sec || 0);
    const from = to - (HISTORY_SLOTS - 1) * period;
    this.send({ type: 'bars', symbol: this.state.symbol, tf, from_server: from, to_server: to, request_id: id });
  }
  private identity(message: Record<string, any>) {
    return {
      instance_id: String(message.instance_id ?? this.state.instance_id),
      account_id: String(message.account_id ?? this.state.account_id),
      server: String(message.server ?? this.state.server), epoch: String(message.epoch ?? this.state.epoch),
      symbol: String(message.symbol ?? this.state.symbol), read_only: message.read_only !== false,
      demo: message.demo === true,
      hedging: message.hedging === true,
      netting_manage: message.netting_manage === true,
      unrestricted: message.unrestricted === true,
      quota_unrestricted: message.quota_unrestricted === true,
      real_no_caps: message.real_no_caps === true,
      block_reason: typeof message.block_reason === 'string' ? message.block_reason : '',
      real_trading: message.real_trading === true,
      capabilities: Array.isArray(message.capabilities) ? message.capabilities.filter((value: unknown): value is string => typeof value === 'string') : [],
      product: typeof message.product === 'string' ? message.product : this.state.product,
      features: Array.isArray(message.features) ? message.features.filter((value: unknown): value is string => typeof value === 'string') : this.state.features,
      server_offset_sec: typeof message.server_offset_sec === 'number' && Number.isFinite(message.server_offset_sec) ? message.server_offset_sec : this.state.server_offset_sec,
    };
  }
  private receive(message: Record<string, any>) {
    if (!message || typeof message !== 'object') return;
    if (typeof message.server_time_ms === 'number' && Number.isFinite(message.server_time_ms)) this.clockOffsetMs = message.server_time_ms - Date.now();
    if (message.type === 'hello') {
      if (message.protocol !== 'tongpin-local' || message.version !== 1) {
        this.disconnect();
        this.update({ phase: 'error', error: '本机 EA 协议版本不兼容，请下载本站对应版本源码。' });
        return;
      }
      this.update({ ...this.identity(message), phase: 'pairing', error: '' });
    } else if (message.type === 'pair_pending') {
      this.update({ phase: 'confirming', error: '' });
    } else if (message.type === 'paired') {
      if (typeof message.token !== 'string' || !message.token) return;
      this.token = message.token;
      this.update({ ...this.identity(message), phase: 'connected', error: '' });
      this.send({ type: 'snapshot' });
      this.historyQueue = [...tfKeys];
      this.nextHistory();
    } else if (message.type === 'error') {
      this.update({ error: String(message.error || message.message || 'EA 拒绝了请求。'), ...(this.state.phase === 'confirming' ? { phase: 'pairing' as const } : {}) });
      if (this.pendingHistory && message.request_id === this.pendingHistory.id) this.nextHistory();
      const read = this.noteReads.get(message.request_id);
      if (read) {
        this.noteReads.delete(message.request_id);
        read.cleanup();
        read.reject(new Error(String(message.error || message.message || 'EA 历史读取失败。')));
      }
      const reviewRead = this.reviewReads.get(message.request_id);
      if (reviewRead) {
        this.reviewReads.delete(message.request_id);
        reviewRead.cleanup();
        reviewRead.reject(new EaBarsError(String(message.code || 'HISTORY_UNAVAILABLE'), String(message.error || message.message || '')));
      }
    } else if (message.type === 'account_changed' || message.type === 'revoked') {
      this.disconnect();
      this.update({ phase: 'error', error: 'MT5 账户或本地授权已改变，请重新配对。' });
    } else if (this.state.phase === 'connected') {
      if ((message.epoch !== undefined && String(message.epoch) !== this.state.epoch)
        || (message.account_id !== undefined && String(message.account_id) !== this.state.account_id)
        || (message.server !== undefined && String(message.server) !== this.state.server)) {
        this.disconnect();
        this.update({ phase: 'error', error: 'MT5 会话已改变，请重新配对并核查未完成指令。' });
        return;
      }
      if (message.type === 'snapshot') {
        this.update({
          account: message.account && typeof message.account === 'object' ? message.account : this.state.account,
          positions: Array.isArray(message.positions) ? message.positions : this.state.positions,
          orders: Array.isArray(message.orders) ? message.orders : this.state.orders,
          tick: message.tick || this.state.tick,
          read_only: message.read_only === undefined ? this.state.read_only : message.read_only !== false,
          demo: message.demo === undefined ? this.state.demo : message.demo === true,
          hedging: message.hedging === undefined ? this.state.hedging : message.hedging === true,
          netting_manage: message.netting_manage === undefined ? this.state.netting_manage : message.netting_manage === true,
          unrestricted: message.unrestricted === undefined ? this.state.unrestricted : message.unrestricted === true,
          quota_unrestricted: message.quota_unrestricted === undefined ? this.state.quota_unrestricted : message.quota_unrestricted === true,
          real_no_caps: message.real_no_caps === undefined ? this.state.real_no_caps : message.real_no_caps === true,
          block_reason: message.block_reason === undefined ? this.state.block_reason : typeof message.block_reason === 'string' ? message.block_reason : '',
          real_trading: message.real_trading === undefined ? this.state.real_trading : message.real_trading === true,
          capabilities: message.capabilities === undefined ? this.state.capabilities
            : Array.isArray(message.capabilities) ? message.capabilities.filter((value: unknown): value is string => typeof value === 'string') : [],
          server_offset_sec: typeof message.server_offset_sec === 'number' && Number.isFinite(message.server_offset_sec) ? message.server_offset_sec : this.state.server_offset_sec,
        });
      } else if (message.type === 'tick') {
        this.update({ tick: message.tick || message });
      } else if (message.type === 'bars' && tfKeys.has(message.tf) && Array.isArray(message.bars)) {
        const reviewRead = this.reviewReads.get(message.request_id);
        if (reviewRead) {
          this.reviewReads.delete(message.request_id);
          reviewRead.cleanup();
          reviewRead.resolve(message as NoteReviewBars);
          return;
        }
        if (!this.pendingHistory || message.request_id !== this.pendingHistory.id || message.tf !== this.pendingHistory.tf) return;
        // range 模式的时间是券商墙钟，减掉券商偏移后与复盘/成交的 UTC 对齐。
        const shift = (message as { range?: unknown }).range ? (this.state.server_offset_sec || 0) : 0;
        const rows = message.bars.filter((row: unknown) => Array.isArray(row) && row.length >= 5 && row.slice(0, 5).every((value: unknown) => typeof value === 'number' && Number.isFinite(value))).map((row: number[]) => (shift ? [row[0] - shift, ...row.slice(1)] : row));
        this.update({ bars: { ...this.state.bars, [message.tf]: rows.slice(-3000) } });
        this.nextHistory();
      } else if (message.type === 'bar' && tfKeys.has(message.tf)) {
        const row = Array.isArray(message.bar) ? message.bar : [message.bar_time, message.open, message.high, message.low, message.close, message.tick_volume || 0];
        if (!row.slice(0, 5).every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) return;
        const previous = this.state.bars[message.tf] || [];
        // 高频热点路径:当前蜡烛更新(替换末尾)和新蜡烛(追加末尾)无需 filter+sort。
        // 只有罕见乱序/历史回补才走慢路径,避免每帧 O(n log n) 扫全数组。
        const lastTime = previous.length ? previous[previous.length - 1][0] : -Infinity;
        let rows: number[][];
        if (row[0] === lastTime) rows = [...previous.slice(0, -1), row];
        else if (row[0] > lastTime) rows = previous.length >= 3000 ? [...previous.slice(1), row] : [...previous, row];
        else { rows = previous.filter((bar) => bar[0] !== row[0]); rows.push(row); rows.sort((a, b) => a[0] - b[0]); rows = rows.slice(-3000); }
        this.update({ bars: { ...this.state.bars, [message.tf]: rows } });
      } else if (message.type === 'pong') {
        this.update({ latency: Math.round(performance.now() - this.pingSent) });
      } else if (message.type === 'history') {
        const read = this.noteReads.get(message.request_id);
        if (!read) return;
        this.noteReads.delete(message.request_id);
        read.cleanup();
        read.resolve(message as NoteHistoryPage);
      } else if (message.type === 'command_result') {
        const id = String(message.command_id || '');
        const old = this.state.commands.find((command) => command.command_id === id);
        if (!old || old.account_id !== this.state.account_id || old.server !== this.state.server) return;
        const timer = this.deadlines.get(id);
        if (timer) window.clearTimeout(timer);
        this.deadlines.delete(id);
        const state = ['completed', 'rejected', 'submitted', 'received', 'uncertain', 'not_found'].includes(message.state) ? message.state : 'uncertain';
        this.update({ commands: this.state.commands.map((command) => command.command_id !== id ? command : {
          ...command, state, error: String(message.error || ''), retcode: message.retcode,
          order: String(message.order || ''), deal: String(message.deal || ''), volume: message.volume, partial: message.partial === true,
        }) });
        if (state === 'received' || state === 'submitted') this.expire(id);
      }
    }
  }
  private expire(id: string) {
    const timer = window.setTimeout(() => {
      this.deadlines.delete(id);
      this.update({ commands: this.state.commands.map((command) => command.command_id !== id ? command : {
        ...command, state: 'uncertain', error: '等待回报超时。请查询结果或在 MT5 中核查，勿重复下单。',
      }) });
    }, 15000);
    this.deadlines.set(id, timer);
  }
  command(action: string, payload: Record<string, unknown>) {
    const { accountAllowed, canManage } = localTradeAccess(this.state);
    if (this.state.phase !== 'connected' || this.state.read_only || !accountAllowed || !this.state.capabilities.includes(action)) throw new Error('本机 EA 当前未授权此账户交易操作。');
    if ((action === 'close' || action === 'modify') && !canManage) throw new Error('净额或账户模式未确认：EA 未明确授权持仓管理。');
    if (this.state.commands.some((command) => command.account_id === this.state.account_id && command.server === this.state.server && unresolvedStates.has(command.state))) throw new Error('当前账户有指令的结果尚未确认，请先查询或在 MT5 中核实。');
    const id = crypto.randomUUID();
    const command: LocalCommand = { command_id: id, action, state: 'sending', created: Date.now(), account_id: this.state.account_id, server: this.state.server };
    this.update({ commands: [command, ...this.state.commands].slice(0, 50), error: '' });
    try {
      this.send({ ...payload, type: 'command', command_id: id, action, expires_at_ms: Math.floor(Date.now() + this.clockOffsetMs + 10000) });
      this.expire(id);
    } catch (error) {
      this.update({ commands: this.state.commands.map((row) => row.command_id === id ? { ...row, state: 'uncertain', error: '发送未获确认，请核查 MT5。' } : row) });
      throw error;
    }
    return id;
  }
  queryCommand(command_id: string) {
    const command = this.state.commands.find((row) => row.command_id === command_id);
    if (!command || command.account_id !== this.state.account_id || command.server !== this.state.server) throw new Error('请连接这条指令对应的 MT5 账户后查询。');
    this.send({ type: 'command_status', command_id });
  }
  requestHistoryPage(range: { from_server: number; to_server: number }, cursor: string, signal: AbortSignal): Promise<NoteHistoryPage> {
    if (this.state.phase !== 'connected' || !this.state.features.includes('history')) return Promise.reject(new Error('当前 EA 不支持笔记历史同步，请使用 SyncTrade（SyncNote Pro）或独立 SyncNote EA。'));
    if (!this.state.history_ready) return Promise.reject(new Error('请等待图表初始化完成后再同步笔记。'));
    if (signal.aborted) return Promise.reject(new Error('笔记同步已取消。'));
    if (this.noteReads.size || this.reviewReads.size) return Promise.reject(new Error('已有一页笔记历史正在读取。'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const read = this.noteReads.get(id);
        if (!read) return;
        this.noteReads.delete(id);
        read.cleanup();
        reject(new Error('笔记同步已取消。'));
      };
      const timer = window.setTimeout(() => {
        const read = this.noteReads.get(id);
        if (!read) return;
        this.noteReads.delete(id);
        read.cleanup();
        reject(new Error('读取本机交易历史超时，可稍后安全重试历史同步。'));
      }, 30000);
      const cleanup = () => { window.clearTimeout(timer); signal.removeEventListener('abort', cancel); };
      this.noteReads.set(id, { resolve, reject, cleanup });
      signal.addEventListener('abort', cancel, { once: true });
      try { this.send({ type: 'history', request_id: id, from: range.from_server, to: range.to_server, cursor, limit: 100 }); }
      catch (error) {
        this.noteReads.delete(id);
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  /** 实时图往左翻页：取比 beforeUtc 更早的一段（返回 UTC 秒，与 state.bars 一致）。 */
  async loadOlderBars(tf: string, beforeUtc: number, slots = HISTORY_SLOTS): Promise<number[][]> {
    if (this.state.phase !== 'connected' || !this.state.features.includes('history') || !this.state.history_ready) throw new Error('本机历史读取尚未就绪。');
    const period = TF_SECONDS[tf] ?? 60;
    const shift = this.state.server_offset_sec || 0;
    const session = { epoch: this.state.epoch, symbol: this.state.symbol, account: this.state.account_id, server: this.state.server, instance: this.state.instance_id };
    const checkSession = () => {
      if (this.state.phase !== 'connected' || this.state.epoch !== session.epoch || this.state.symbol !== session.symbol
        || this.state.account_id !== session.account || this.state.server !== session.server || this.state.instance_id !== session.instance) {
        throw new Error('本机历史读取会话已改变，请重新请求。');
      }
    };
    let to = Math.floor(beforeUtc + shift) - 1;
    const controller = new AbortController();
    // A fixed calendar window may lie entirely inside a market closure. Probe a
    // bounded three extra windows; this never proves the terminal history ended.
    for (let probe = 0; probe < 4; probe += 1) {
      checkSession();
      const from = to - (slots - 1) * period;
      if (from < 1 || to <= from) return [];
      try {
        const page = await this.requestReviewBars(session.symbol, tf, { from_server: from, to_server: to }, controller.signal);
        checkSession();
        if (page.symbol !== session.symbol || page.tf !== tf || page.time_basis !== 'broker_server'
          || page.range?.from_server !== from || page.range?.to_server !== to) throw new Error('HISTORY_RESPONSE_MISMATCH');
        if (page.bars.length) return page.bars.map((row) => (shift ? [row[0] - shift, ...row.slice(1)] : row));
      } catch (error) {
        checkSession();
        if (!(error instanceof EaBarsError) || error.code !== 'HISTORY_UNAVAILABLE'
          || !/^(?:MT5 history is not ready for this range|MT5 history starts later than the requested range)$/.test(error.detail)) throw error;
      }
      to = from - 1;
    }
    return [];
  }

  requestReviewBars(symbol: string, tf: string, range: { from_server: number; to_server: number }, signal: AbortSignal): Promise<NoteReviewBars> {
    if (this.state.phase !== 'connected' || !this.state.features.includes('history') || !this.state.history_ready) return Promise.reject(new Error('本机历史读取尚未就绪。'));
    if (signal.aborted) return Promise.reject(new Error('复盘同步已取消。'));
    if (this.noteReads.size || this.reviewReads.size) return Promise.reject(new Error('已有笔记历史读取任务。'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const read = this.reviewReads.get(id);
        if (!read) return;
        this.reviewReads.delete(id);
        read.cleanup();
        reject(new Error('复盘同步已取消。'));
      };
      const timer = window.setTimeout(() => {
        const read = this.reviewReads.get(id);
        if (!read) return;
        this.reviewReads.delete(id);
        read.cleanup();
        reject(new Error('HISTORY_TIMEOUT'));
      }, 30000);
      const cleanup = () => { window.clearTimeout(timer); signal.removeEventListener('abort', cancel); };
      this.reviewReads.set(id, { resolve, reject, cleanup });
      signal.addEventListener('abort', cancel, { once: true });
      try { this.send({ type: 'bars', request_id: id, symbol, tf, from_server: range.from_server, to_server: range.to_server, limit: 2000 }); }
      catch (error) {
        this.reviewReads.delete(id);
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

export const localTerminal = new LocalTerminal();
export const useLocalTerminal = () => useSyncExternalStore(localTerminal.subscribe, localTerminal.getSnapshot);
