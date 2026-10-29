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

export function previewRisk(request: OrderRequest, ref: PriceRef, account: Account | null): RiskPreview {
  const entry = resolveEntry(request, ref);
  const stop = request.sl > 0 ? request.sl : 0;
  const target = request.tp > 0 ? request.tp : 0;
  const problems: string[] = [];

  if (!Number.isFinite(request.volume) || request.volume <= 0) problems.push('手数必须大于 0');
  if (request.volume > MAX_VOLUME) problems.push('手数不得超过 ' + MAX_VOLUME);

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

  const notional = entry > 0 && request.volume > 0 ? entry * request.volume * CONTRACT_SIZE : 0;
  const leverage = account && account.leverage && account.leverage > 0 ? account.leverage : 0;
  const marginUsd = notional > 0 && leverage > 0 ? notional / leverage : null;
  const riskUsd = entry > 0 && stop > 0 && request.volume > 0 ? Math.abs(entry - stop) * request.volume * CONTRACT_SIZE : null;
  const rewardUsd = entry > 0 && target > 0 && request.volume > 0 ? Math.abs(target - entry) * request.volume * CONTRACT_SIZE : null;
  const rr = riskUsd && riskUsd > 0 && rewardUsd != null ? rewardUsd / riskUsd : null;
  const balance = account?.balance ?? 0;
  const riskPctBalance = riskUsd != null && balance > 0 ? (riskUsd / balance) * 100 : null;

  return { entry, notional, marginUsd, riskUsd, rewardUsd, rr, riskPctBalance, problems };
}

export const fmtPrice = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? '—' : value.toFixed(2));
export const fmtVolume = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? '—' : value.toFixed(2));
export const fmtMoney = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
