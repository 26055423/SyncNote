/** 下单面板的类型与风险计算（搬自 trade_dashboard 的 lib/risk.ts）。 */

export type OrderAction = 'market' | 'limit' | 'stop';
export type OrderSide = 'buy' | 'sell';

export interface OrderRequest {
  action: OrderAction;
  side: OrderSide;
  symbol: string;
  volume: number;
  price: number;
  sl: number;
  tp: number;
  deviation: number;
  magic: number;
  comment: string;
}

export interface OrderResult {
  ok: boolean;
  retcode?: number;
  retcode_name?: string;
  order?: string;
  deal?: string;
  price?: number;
  volume?: number;
  error?: string;
  detail?: string;
  uncertain?: boolean;
}

export interface OrderAttempt {
  status: number | null;
  result: OrderResult | null;
  transportError: string | null;
  idempotencyKey: string;
}

export interface Account {
  login?: string;
  balance?: number;
  equity?: number;
  currency?: string;
  leverage?: number;
}

export const CONTRACT_SIZE = 100;
/** MT5 tick values use the account's deposit currency. */
export interface SymbolSpec {
  tick_size: number;
  tick_value_loss: number;
  tick_value_profit?: number;
  volume_min: number;
  volume_max: number;
  volume_step: number;
  digits?: number;
}
export interface RiskSizing {
  volume: number;
  loss: number | null;
  problem: string | null;
  capped: boolean;
}
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function sizeByRisk(request: Pick<OrderRequest, 'action' | 'side' | 'price' | 'sl'>, ref: PriceRef, account: Account | null, spec: SymbolSpec | null, budget: number, quotaUnrestricted = false): RiskSizing {
  const invalid = (problem: string): RiskSizing => ({ volume: 0, loss: null, problem, capped: false });
  if (!positive(budget)) return invalid('请填写大于 0 的风险金额');
  if (!account?.currency) return invalid('等待 EA 确认账户货币');
  const entry = request.action === 'market' ? (request.side === 'buy' ? ref.ask : ref.bid) : request.price;
  if (!positive(entry)) return invalid('请先填写有效入场价或等待报价');
  if (!positive(request.sl)) return invalid('以损定仓必须开启并填写止损');
  if (request.side === 'buy' ? request.sl >= entry : request.sl <= entry) return invalid('止损必须在入场价的亏损一侧');
  if (!spec || ![spec.tick_size, spec.tick_value_loss, spec.volume_min, spec.volume_max, spec.volume_step].every(positive)
    || spec.volume_max < spec.volume_min || spec.volume_step < 1e-8) return invalid('等待当前品种的有效券商合约规格');
  const perLot = Math.abs(entry - request.sl) / spec.tick_size * spec.tick_value_loss;
  if (!positive(perLot)) return invalid('止损距离无法计算，请检查价格与合约规格');
  const cap = Math.min(spec.volume_max, quotaUnrestricted ? spec.volume_max : MAX_VOLUME);
  const raw = Math.min(budget / perLot, cap);
  let units = Math.floor(raw / spec.volume_step + 1e-10);
  if (!Number.isSafeInteger(units)) return invalid('手数计算超出有效范围，请检查合约规格');
  let volume = Number((units * spec.volume_step).toFixed(8));
  if (volume * perLot > budget || volume > cap) {
    units -= 1;
    volume = Number((units * spec.volume_step).toFixed(8));
  }
  if (volume < spec.volume_min || volume <= 0) return invalid('风险金额不足以开最小手数；请调整金额或止损距离');
  return { volume, loss: volume * perLot, problem: null, capped: budget / perLot > cap };
}
const MAX_VOLUME = 1.0;
const PRICE_DEVIATION_PCT = 20;

export interface PriceRef {
  bid: number;
  ask: number;
}

export interface RiskPreview {
  entry: number;
  notional: number;
  marginUsd: number | null;
  riskUsd: number | null;
  rewardUsd: number | null;
  rr: number | null;
  riskPctBalance: number | null;
  problems: string[];
}

export function resolveEntry(request: OrderRequest, ref: PriceRef): number {
  if (request.action === 'market') return request.side === 'buy' ? ref.ask : ref.bid;
  return request.price;
}

export function previewRisk(request: OrderRequest, ref: PriceRef, account: Account | null, quotaUnrestricted = false, spec: SymbolSpec | null = null): RiskPreview {
  const entry = resolveEntry(request, ref);
  const stop = request.sl > 0 ? request.sl : 0;
  const target = request.tp > 0 ? request.tp : 0;
  const problems: string[] = [];

  if (!Number.isFinite(request.volume) || request.volume <= 0) problems.push('手数必须大于 0');
  if (!quotaUnrestricted && request.volume > MAX_VOLUME) problems.push('手数不得超过 ' + MAX_VOLUME);
  if (spec && positive(spec.volume_step)) {
    if (request.volume < spec.volume_min || request.volume > spec.volume_max) problems.push('手数超出当前券商的最小/最大范围');
    if (Math.abs(request.volume / spec.volume_step - Math.round(request.volume / spec.volume_step)) > 1e-6) problems.push('手数必须符合当前券商的手数步长');
  }

  if (request.action !== 'market') {
    if (!(request.price > 0)) problems.push('限价/止损单必须填写价格');
    const mid = (ref.bid + ref.ask) / 2;
    if (request.price > 0 && mid > 0) {
      const deviation = (Math.abs(request.price - mid) / mid) * 100;
      if (deviation > PRICE_DEVIATION_PCT) {
        problems.push('价格偏离中间价 ' + deviation.toFixed(1) + '%（上限 ' + PRICE_DEVIATION_PCT + '%）');
      }
    }
    if (request.price > 0) {
      if (request.action === 'limit' && request.side === 'buy' && request.price >= ref.ask) problems.push('买入限价需低于当前卖价');
      if (request.action === 'limit' && request.side === 'sell' && request.price <= ref.bid) problems.push('卖出限价需高于当前买价');
      if (request.action === 'stop' && request.side === 'buy' && request.price <= ref.ask) problems.push('买入止损需高于当前卖价');
      if (request.action === 'stop' && request.side === 'sell' && request.price >= ref.bid) problems.push('卖出止损需低于当前买价');
    }
  }

  if (entry > 0 && stop > 0) {
    if (request.side === 'buy' && stop >= entry) problems.push('买单止损需低于入场价');
    if (request.side === 'sell' && stop <= entry) problems.push('卖单止损需高于入场价');
  }
  if (entry > 0 && target > 0) {
    if (request.side === 'buy' && target <= entry) problems.push('买单止盈需高于入场价');
    if (request.side === 'sell' && target >= entry) problems.push('卖单止盈需低于入场价');
  }

  // Other contracts must never inherit gold's 100 oz multiplier.
  const goldEstimate = /^XAUUSD(?:[._-].*|m|c)?$/i.test(request.symbol) && (!account?.currency || account.currency === 'USD');
  const notional = goldEstimate && entry > 0 && request.volume > 0 ? entry * request.volume * CONTRACT_SIZE : 0;
  const leverage = account && account.leverage && account.leverage > 0 ? account.leverage : 0;
  const marginUsd = notional > 0 && leverage > 0 ? notional / leverage : null;
  // 只有止损/止盈在正确一侧时才算风险收益，否则方向错了也会算出漂亮数字，误导人。
  const stopValid = entry > 0 && stop > 0 && (request.side === 'buy' ? stop < entry : stop > entry);
  const targetValid = entry > 0 && target > 0 && (request.side === 'buy' ? target > entry : target < entry);
  const brokerLoss = spec && positive(spec.tick_size) && positive(spec.tick_value_loss) ? spec.tick_value_loss / spec.tick_size : null;
  const brokerProfit = spec && positive(spec.tick_size) && positive(spec.tick_value_profit) ? spec.tick_value_profit / spec.tick_size : null;
  const riskUsd = stopValid && request.volume > 0 ? Math.abs(entry - stop) * request.volume * (brokerLoss ?? (goldEstimate && !spec ? CONTRACT_SIZE : 0)) || null : null;
  const rewardUsd = targetValid && request.volume > 0 ? Math.abs(target - entry) * request.volume * (brokerProfit ?? (goldEstimate && !spec ? CONTRACT_SIZE : 0)) || null : null;
  const rr = riskUsd != null && rewardUsd != null ? rewardUsd / riskUsd : stopValid && targetValid ? Math.abs(target - entry) / Math.abs(entry - stop) : null;
  const balance = account?.balance ?? 0;
  const riskPctBalance = riskUsd != null && balance > 0 ? (riskUsd / balance) * 100 : null;

  return { entry, notional, marginUsd, riskUsd, rewardUsd, rr, riskPctBalance, problems };
}

export const fmtPrice = (value: number | null | undefined, digits = 2) => (value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits));
export const fmtVolume = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8, useGrouping: false }));
export const fmtMoney = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
