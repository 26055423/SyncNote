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
  capabilities: string[];
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

const freshState = (): LocalTerminalState => ({
  phase: 'disconnected', error: '', instance_id: '', account_id: '', server: '', epoch: '',
  symbol: 'XAUUSD', read_only: true, demo: false, capabilities: [], latency: null, account: {}, tick: null,
  positions: [], orders: [], bars: {}, history_ready: false, commands: [], revision: 0,
});
const terminalStates = new Set(['completed', 'rejected']);
const unresolvedStates = new Set(['sending', 'received', 'submitted', 'uncertain', 'not_found']);
const tfKeys = new Set(['1m', '5m', '15m', '1h']);

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
    this.send({ type: 'bars', symbol: this.state.symbol, tf, limit: 400, request_id: id });
  }
  private identity(message: Record<string, any>) {
    return {
      instance_id: String(message.instance_id ?? this.state.instance_id),
      account_id: String(message.account_id ?? this.state.account_id),
      server: String(message.server ?? this.state.server), epoch: String(message.epoch ?? this.state.epoch),
      symbol: String(message.symbol ?? this.state.symbol), read_only: message.read_only !== false,
      demo: message.demo === true,
      capabilities: Array.isArray(message.capabilities) ? message.capabilities.filter((value: unknown): value is string => typeof value === 'string') : this.state.capabilities,
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
    } else if (message.type === 'account_changed' || message.type === 'revoked') {
      this.disconnect();
      this.update({ phase: 'error', error: 'MT5 账户或本地授权已改变，请重新配对。' });
    } else if (this.state.phase === 'connected') {
      if (message.epoch !== undefined && String(message.epoch) !== this.state.epoch) {
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
        });
      } else if (message.type === 'tick') {
        this.update({ tick: message.tick || message });
      } else if (message.type === 'bars' && tfKeys.has(message.tf) && Array.isArray(message.bars)) {
        if (!this.pendingHistory || message.request_id !== this.pendingHistory.id || message.tf !== this.pendingHistory.tf) return;
        const rows = message.bars.filter((row: unknown) => Array.isArray(row) && row.length >= 5 && row.slice(0, 5).every((value: unknown) => typeof value === 'number' && Number.isFinite(value)));
        this.update({ bars: { ...this.state.bars, [message.tf]: rows.slice(-3000) } });
        this.nextHistory();
      } else if (message.type === 'bar' && tfKeys.has(message.tf)) {
        const row = Array.isArray(message.bar) ? message.bar : [message.bar_time, message.open, message.high, message.low, message.close, message.tick_volume || 0];
        if (!row.slice(0, 5).every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) return;
        const previous = this.state.bars[message.tf] || [];
        const rows = previous.filter((bar) => bar[0] !== row[0]);
        rows.push(row);
        rows.sort((a, b) => a[0] - b[0]);
        this.update({ bars: { ...this.state.bars, [message.tf]: rows.slice(-3000) } });
      } else if (message.type === 'pong') {
        this.update({ latency: Math.round(performance.now() - this.pingSent) });
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
    if (this.state.phase !== 'connected' || this.state.read_only || !this.state.demo || !this.state.capabilities.includes(action)) throw new Error('本机 EA 当前未授权此模拟账户交易操作。');
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
}

export const localTerminal = new LocalTerminal();
export const useLocalTerminal = () => useSyncExternalStore(localTerminal.subscribe, localTerminal.getSnapshot);
