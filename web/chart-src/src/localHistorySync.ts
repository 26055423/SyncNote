import { useSyncExternalStore } from 'react';
import { localTerminal, type LocalTerminalState, type NoteHistoryPage } from './localTerminal';

export interface HistoryImportBody {
  schema: 'syncnote-history.v1';
  website_user_id: string;
  account_key: string;
  account: string;
  server: string;
  currency: string;
  server_offset_sec: number;
  batch_id: string;
  range: { from_server: number; to_server: number };
  deals: Array<Record<string, unknown>>;
  checkpoint: { through_server: number; last_deal_ticket: string; window_complete: boolean };
}
interface HistoryAck { ok: boolean; batch_id: string; account_key: string }
interface ReviewJob { ticket: string; symbol: string; opened_server: number; closed_server: number; account: string; server: string; source_account_key?: string }
interface ReviewJobResponse { ok: boolean; website_user_id: string; review_job: ReviewJob | null }
interface ReviewImportBody {
  website_user_id: string;
  account: string;
  server: string;
  account_key: string;
  ticket: string;
  opened_server: number;
  closed_server: number;
  charts: Record<string, number[][]>;
  errors: Record<string, string>;
  error?: string;
}
interface Checkpoint {
  version: 1;
  account_key: string;
  account: string;
  server: string;
  range: { from_server: number; to_server: number };
  cursor: string;
  through_server: number;
  last_deal_ticket: string;
  window_complete: boolean;
  saved_at: number;
}
export interface HistorySyncState {
  enabled: boolean;
  status: 'off' | 'reading' | 'uploading' | 'idle' | 'error';
  message: string;
  pages: number;
  deals: number;
  last_synced: number | null;
  reviews: number;
  review_message: string;
  account: string;
  server: string;
}
interface Dependencies {
  terminal: Pick<typeof localTerminal, 'getSnapshot' | 'subscribe' | 'requestHistoryPage' | 'requestReviewBars'>;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  upload: (body: HistoryImportBody, signal: AbortSignal) => Promise<HistoryAck>;
  accountKey: (server: string, account: string) => Promise<string>;
  uuid: () => string;
  now: () => number;
  schedule: (callback: () => void, ms: number) => number;
  cancelSchedule: (id: number) => void;
  reviewJob?: (signal: AbortSignal) => Promise<ReviewJobResponse>;
  uploadReview?: (body: ReviewImportBody, signal: AbortSignal) => Promise<{ ok: boolean }>;
}

const EMPTY: HistorySyncState = { enabled: false, status: 'off', message: '', pages: 0, deals: 0, reviews: 0, review_message: '', last_synced: null, account: '', server: '' };
const DAY = 86400;
const sameSession = (state: LocalTerminalState) => [state.instance_id, state.account_id, state.server, state.epoch].join('\n');
export async function historyAccountKey(server: string, account: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${server}\n${account}`));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/** Only acknowledged non-secret scan cursors persist. Consent and raw pages stay in memory. */
export class LocalHistorySync {
  private state: HistorySyncState = { ...EMPTY };
  private listeners = new Set<() => void>();
  private userId = '';
  private generation = 0;
  private controller: AbortController | null = null;
  private session = '';
  private wakeup: number | null = null;
  private runningGeneration: number | null = null;
  private checkpoint: Checkpoint | null = null;
  private storageKey = '';
  private pending: { body: HistoryImportBody; checkpoint: Checkpoint } | null = null;
  constructor(private readonly dependencies: Dependencies) {
    dependencies.terminal.subscribe(() => {
      if (!this.state.enabled) return;
      const current = dependencies.terminal.getSnapshot();
      if (current.phase !== 'connected' || sameSession(current) !== this.session) this.stop('本机连接或账户已改变，同步已暂停；请确认账户后重新开启。');
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<HistorySyncState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  bindUser(userId: string) {
    if (this.userId === userId) return;
    this.stop(this.userId ? '网站登录账户已改变，同步授权已清除。' : '');
    this.userId = userId;
    this.update({ pages: 0, deals: 0, reviews: 0, review_message: '', last_synced: null, account: '', server: '' });
  }
  stop(message = '笔记同步已暂停。') {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    if (this.wakeup !== null) this.dependencies.cancelSchedule(this.wakeup);
    this.wakeup = null;
    this.pending = null;
    this.checkpoint = null;
    this.storageKey = '';
    this.session = '';
    this.update({ enabled: false, status: 'off', message });
  }
  async start() {
    const terminal = this.dependencies.terminal.getSnapshot();
    if (!this.userId) throw new Error('请先登录网站。');
    if (terminal.phase !== 'connected' || !terminal.features.includes('history')) throw new Error('请连接支持历史同步的 SyncTrade（SyncNote Pro）EA。');
    if (!terminal.history_ready) throw new Error('请等待图表初始化完成后再开启同步。');
    this.stop('');
    const generation = this.generation;
    this.controller = new AbortController();
    this.session = sameSession(terminal);
    this.update({ enabled: true, status: 'reading', message: '正在读取已保存的同步进度…', account: terminal.account_id, server: terminal.server, pages: 0, deals: 0 });
    try {
      const accountKey = await this.dependencies.accountKey(terminal.server, terminal.account_id);
      if (!this.active(generation)) return;
      this.storageKey = `syncnote-history-v1:${encodeURIComponent(this.userId)}:${accountKey}`;
      const saved = this.dependencies.storage.getItem(this.storageKey);
      if (saved) {
        const checkpoint = JSON.parse(saved) as Checkpoint;
        if (checkpoint.version !== 1 || checkpoint.account_key !== accountKey || checkpoint.account !== terminal.account_id || checkpoint.server !== terminal.server
          || typeof checkpoint.cursor !== 'string' || !Number.isFinite(checkpoint.through_server)
          || !Number.isFinite(checkpoint.range?.from_server) || !Number.isFinite(checkpoint.range?.to_server)
          || checkpoint.range.from_server > checkpoint.range.to_server) throw new Error('浏览器中的同步进度无效，请清除此网站的同步进度后再试。');
        this.checkpoint = checkpoint;
        this.update({ last_synced: checkpoint.saved_at });
      } else {
        const to = Math.floor(this.dependencies.now() / 1000) + terminal.server_offset_sec;
        this.checkpoint = { version: 1, account_key: accountKey, account: terminal.account_id, server: terminal.server,
          range: { from_server: Math.max(0, to - 365 * DAY), to_server: to }, cursor: '', through_server: Math.max(0, to - 365 * DAY), last_deal_ticket: '0', window_complete: false, saved_at: 0 };
      }
      await this.pump(generation);
    } catch (error) {
      if (this.active(generation)) this.update({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
  retry() {
    if (!this.state.enabled || this.state.status !== 'error') return;
    if (!this.checkpoint || !this.storageKey) { void this.start(); return; }
    void this.pump(this.generation);
  }
  private active(generation: number) {
    return generation === this.generation && this.state.enabled && this.controller !== null && !this.controller.signal.aborted
      && this.dependencies.terminal.getSnapshot().phase === 'connected'
      && sameSession(this.dependencies.terminal.getSnapshot()) === this.session;
  }
  private async pump(generation: number) {
    if (!this.active(generation) || !this.checkpoint || this.runningGeneration === generation) return;
    this.runningGeneration = generation;
    const signal = this.controller!.signal;
    try {
      if (this.checkpoint.window_complete && !this.pending) {
        const terminal = this.dependencies.terminal.getSnapshot();
        const to = Math.floor(this.dependencies.now() / 1000) + terminal.server_offset_sec;
        this.checkpoint = { ...this.checkpoint, range: { from_server: Math.max(0, Math.min(to, this.checkpoint.through_server) - DAY), to_server: to }, cursor: '', window_complete: false };
      }
      while (this.active(generation)) {
        if (!this.pending) {
          const checkpoint: Checkpoint = this.checkpoint!;
          this.update({ status: 'reading', message: '读取本机全品种交易历史，每页最多 100 条…' });
          const page = await this.dependencies.terminal.requestHistoryPage(checkpoint.range, checkpoint.cursor, signal);
          if (!this.active(generation)) return;
          this.validatePage(page, checkpoint);
          const lastTicket = page.deals.length ? String(page.deals[page.deals.length - 1].deal_ticket ?? page.deals[page.deals.length - 1].ticket ?? '0') : checkpoint.last_deal_ticket || '0';
          const next: Checkpoint = { ...checkpoint, cursor: page.next_cursor, through_server: page.through_server,
            last_deal_ticket: lastTicket, window_complete: !page.has_more, saved_at: 0 };
          const terminal = this.dependencies.terminal.getSnapshot();
          this.pending = {
            body: { schema: 'syncnote-history.v1', website_user_id: this.userId, account_key: checkpoint.account_key,
              account: checkpoint.account, server: checkpoint.server, currency: String(terminal.account.currency || ''),
              server_offset_sec: page.server_offset_sec, batch_id: this.dependencies.uuid(), range: { ...checkpoint.range }, deals: page.deals,
              checkpoint: { through_server: page.through_server, last_deal_ticket: lastTicket, window_complete: !page.has_more } },
            checkpoint: next,
          };
        }
        const pending: { body: HistoryImportBody; checkpoint: Checkpoint } = this.pending!;
        this.update({ status: 'uploading', message: `正在将 ${pending.body.deals.length} 条历史记录同步到当前网站账户…` });
        const ack = await this.dependencies.upload(pending.body, signal);
        if (!this.active(generation)) return;
        if (ack.ok !== true || ack.batch_id !== pending.body.batch_id || ack.account_key !== pending.body.account_key) throw new Error('服务器未确认本批历史，未推进同步进度；可安全重试。');
        const saved: Checkpoint = { ...pending.checkpoint, saved_at: this.dependencies.now() };
        this.dependencies.storage.setItem(this.storageKey, JSON.stringify(saved));
        this.checkpoint = saved;
        this.pending = null;
        this.update({ pages: this.state.pages + 1, deals: this.state.deals + pending.body.deals.length, last_synced: saved.saved_at });
        if (saved.window_complete) {
          await this.processReview(generation, saved);
          if (!this.active(generation)) return;
          this.update({ status: 'idle', message: '当前窗口已同步，网页保持打开时每 30 秒检查一次；回查最近一天以补齐迟到成交和费用。' });
          this.wakeup = this.dependencies.schedule(() => { this.wakeup = null; void this.pump(generation); }, 30000);
          return;
        }
      }
    } catch (error) {
      if (this.active(generation)) this.update({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.runningGeneration === generation) this.runningGeneration = null;
    }
  }
  private validatePage(page: NoteHistoryPage, checkpoint: Checkpoint) {
    const terminal = this.dependencies.terminal.getSnapshot();
    if (page.account_key !== checkpoint.account_key || page.account_id !== checkpoint.account || page.server !== checkpoint.server || page.epoch !== terminal.epoch
      || page.time_basis !== 'broker_server' || page.range?.from_server !== checkpoint.range.from_server || page.range?.to_server !== checkpoint.range.to_server) throw new Error('EA 历史所属账户或时间窗口不一致，同步已停止。');
    if (!Array.isArray(page.deals) || page.deals.length > 100 || typeof page.next_cursor !== 'string' || typeof page.has_more !== 'boolean'
      || !Number.isFinite(page.through_server) || !Number.isFinite(page.server_offset_sec)
      || page.through_server < checkpoint.range.from_server - 1 || page.through_server > checkpoint.range.to_server
      || (page.has_more && (!page.next_cursor || page.next_cursor === checkpoint.cursor))) throw new Error('EA 历史分页格式或进度无效，未上传。');
  }
  private async processReview(generation: number, checkpoint: Checkpoint) {
    if (!this.dependencies.reviewJob || !this.dependencies.uploadReview || !this.active(generation)) return;
    const signal = this.controller!.signal;
    try {
      const response = await this.dependencies.reviewJob(signal);
      if (!this.active(generation)) return;
      if (response.ok !== true || response.website_user_id !== this.userId) throw new Error('网站复盘任务所属账户已改变。');
      const job = response.review_job;
      if (!job) { this.update({ review_message: '暂无待补齐的交易复盘图。' }); return; }
      if ((job.source_account_key && job.source_account_key !== checkpoint.account_key)
        || (job.account && job.account !== checkpoint.account) || (job.server && job.server !== checkpoint.server)) {
        this.update({ review_message: '有其他 MT5 账户的复盘待同步，请连接对应账户；当前账户不会上传其图表。' });
        return;
      }
      if (!Number.isFinite(job.opened_server) || !Number.isFinite(job.closed_server) || job.opened_server <= 0 || job.closed_server < job.opened_server || !job.symbol) throw new Error('复盘任务时间范围无效。');
      const charts: Record<string, number[][]> = {}, errors: Record<string, string> = {};
      for (const [name, tf, seconds] of [['M1', '1m', 60], ['M5', '5m', 300], ['M15', '15m', 900], ['H1', '1h', 3600]] as const) {
        if (!this.active(generation)) return;
        const terminal = this.dependencies.terminal.getSnapshot();
        if (terminal.commands.some((command) => command.account_id === terminal.account_id && command.server === terminal.server && ['sending', 'received', 'submitted'].includes(command.state))) {
          this.update({ review_message: '本机交易指令优先，待指令完成后再补齐复盘图。' });
          return;
        }
        const range = { from_server: Math.floor(job.opened_server / seconds) * seconds - 30 * seconds, to_server: Math.floor(job.closed_server / seconds) * seconds + 30 * seconds };
        charts[name] = [];
        errors[name] = '';
        if (Math.floor((range.to_server - range.from_server) / seconds) + 1 > 2000) { errors[name] = 'range_too_long'; continue; }
        this.update({ review_message: `正在读取 ${job.symbol} #${job.ticket} 的 ${name} 复盘图…` });
        try {
          const page = await this.dependencies.terminal.requestReviewBars(job.symbol, tf, range, signal);
          if (!this.active(generation)) return;
          const rows = page.bars;
          if (page.time_basis !== 'broker_server' || page.symbol !== job.symbol || page.tf !== tf
            || page.range?.from_server !== range.from_server || page.range?.to_server !== range.to_server
            || !Array.isArray(rows) || rows.length > 2000
            || !rows.every((row) => Array.isArray(row) && row.length >= 5 && row.slice(0, 5).every((value) => Number.isFinite(value)))) throw new Error('history_format');
          if (!rows.length || rows[0][0] > job.opened_server || rows[rows.length - 1][0] + seconds <= job.closed_server) throw new Error('history_unavailable');
          charts[name] = rows.map((row) => row.slice(0, 5));
        } catch (error) {
          if (!this.active(generation)) return;
          errors[name] = error instanceof Error && /^[a-z_]+$/i.test(error.message) ? error.message.toLowerCase() : 'history_unavailable';
        }
      }
      if (!this.active(generation)) return;
      const ack = await this.dependencies.uploadReview({ website_user_id: this.userId, account: checkpoint.account, server: checkpoint.server,
        account_key: checkpoint.account_key, ticket: String(job.ticket), opened_server: job.opened_server, closed_server: job.closed_server, charts, errors }, signal);
      if (!this.active(generation)) return;
      if (ack.ok !== true) throw new Error('网站未确认复盘图。');
      this.update({ reviews: this.state.reviews + 1, review_message: Object.values(errors).some(Boolean) ? '复盘图已同步；缺少历史或范围过长的周期已明确标记。' : '四周期复盘图已同步，可在笔记中查看与分享。' });
    } catch (error) {
      if (this.active(generation)) this.update({ review_message: `历史已同步，复盘图稍后再试：${error instanceof Error ? error.message : String(error)}` });
    }
  }
}

const uploadHistory = async (body: HistoryImportBody, signal: AbortSignal): Promise<HistoryAck> => {
  const response = await fetch('/api/mt5/history-import', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || (response.status === 401 ? '网站登录已过期，笔记同步已暂停。' : `历史同步失败（HTTP ${response.status}），进度未推进。`));
  return data as HistoryAck;
};
export const localHistorySync = new LocalHistorySync({
  terminal: localTerminal,
  storage: { getItem: (key) => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) },
  upload: uploadHistory, accountKey: historyAccountKey, uuid: () => crypto.randomUUID(), now: () => Date.now(),
  schedule: (callback, ms) => window.setTimeout(callback, ms), cancelSchedule: (id) => window.clearTimeout(id),
  reviewJob: async (signal) => {
    const response = await fetch('/api/mt5/history-job', { credentials: 'same-origin', cache: 'no-store', signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取复盘任务失败。');
    return data as ReviewJobResponse;
  },
  uploadReview: async (body, signal) => {
    const response = await fetch('/api/mt5/history-review', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '复盘图同步失败。');
    return data as { ok: boolean };
  },
});
export const useLocalHistorySync = () => useSyncExternalStore(localHistorySync.subscribe, localHistorySync.getSnapshot);
