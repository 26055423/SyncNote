import type { OrderAction, OrderRequest } from './risk';

export type TradePriceField = 'entry' | 'sl' | 'tp';
export interface ChartOrderDraft {
  scope: string;
  symbol: string;
  action: OrderAction;
  side: 'buy' | 'sell';
  entry: number;
  sl: number;
  tp: number;
  volume: number;
  editable: boolean;
  step: number;
  digits: number;
}
export interface ChartOrderEdit { id: number; scope: string; field: TradePriceField; price: number }

export function snapTradePrice(price: number, step: number, digits: number): number {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(step) || step <= 0 || !Number.isInteger(digits) || digits < 0 || digits > 8) throw new Error('请使用有效的券商价格');
  const value = Number((Math.round(price / step) * step).toFixed(digits));
  if (value <= 0) throw new Error('价格必须大于 0');
  return value;
}

export function editDraftPrice(draft: ChartOrderDraft, field: TradePriceField, price: number, quote: { bid: number; ask: number }, allowed: readonly OrderAction[]): Partial<OrderRequest> {
  if (!draft.editable) throw new Error('待下单票据当前不可编辑');
  const value = snapTradePrice(price, draft.step, draft.digits);
  if (field !== 'entry') return { [field]: value };
  let action = draft.action;
  if (action === 'market') {
    const current = draft.side === 'buy' ? quote.ask : quote.bid;
    if (!(current > 0)) throw new Error('等待当前报价');
    action = (draft.side === 'buy' ? value < current : value > current) ? 'limit' : 'stop';
  }
  if (!allowed.includes(action)) throw new Error('EA 未授权拖动入场价所需的挂单类型');
  return { price: value, action };
}

type Session = { account_id: string; server: string; epoch: string; instance_id: string; symbol: string };
interface ModifyTerminal {
  getSnapshot(): Session & { phase: string; symbol_switching?: boolean; positions: Array<Record<string, any>>; commands: Array<Record<string, any>>; symbol_spec?: { tick_size: number; digits?: number } | null };
  command(action: string, payload: Record<string, unknown>): string;
}

/** One drag submits one modify; only terminal.command decides permissions. */
export function modifyPositionLevel(terminal: ModifyTerminal, scope: Session, ticket: string, field: TradePriceField, price: number, notify: (message: string) => void, revert: () => void, schedule = (fn: () => void) => window.setTimeout(fn, 250), now = () => Date.now()): void {
  const sameSession = () => {
    const current = terminal.getSnapshot();
    return current.phase === 'connected' && !current.symbol_switching && (['account_id','server','epoch','instance_id','symbol'] as const).every(key => current[key] === scope[key]);
  };
  try {
    if (!sameSession()) throw new Error('本机账户或品种已变化，请重新连接核查');
    if (field === 'entry') throw new Error('已成交持仓的开仓价格不能修改');
    const snapshot = terminal.getSnapshot();
    const position = snapshot.positions.find(row => String(row.ticket) === ticket && row.symbol === scope.symbol);
    if (!position) throw new Error('持仓已变化，请刷新后核查');
    if (!snapshot.symbol_spec) throw new Error('等待当前品种的券商价格规格');
    const value = snapTradePrice(price, snapshot.symbol_spec.tick_size, snapshot.symbol_spec.digits ?? 2);
    if (Math.abs(Number(position[field] || 0)-value) < 1e-8) { revert(); return; }
    const id = terminal.command('modify', { ticket, sl: field === 'sl' ? value : Number(position.sl || 0), tp: field === 'tp' ? value : Number(position.tp || 0) });
    const start = now();
    const watch = () => {
      if (!sameSession()) return;
      const command = terminal.getSnapshot().commands.find(row => row.command_id === id);
      if (command?.state === 'completed') return;
      if (command?.state === 'rejected') { notify(command.error || 'EA 拒绝了改单，图表恢复已知持仓价格'); revert(); return; }
      if (!command || ['uncertain','not_found'].includes(command.state) || now()-start > 15000) {
        notify('改单结果待核实，图表恢复最后已知价格；请查询执行结果或在 MT5 核查，勿重复提交'); revert(); return;
      }
      schedule(watch);
    };
    schedule(watch);
  } catch (error) { notify(error instanceof Error ? error.message : String(error)); revert(); }
}
