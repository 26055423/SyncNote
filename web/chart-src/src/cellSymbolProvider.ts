import { api } from './api';

/**
 * 单格独立品种的数据源：行情/复盘共用的 `bars` 轨道，按需向 `/api/market/bars` 取。
 *
 * 只在「商品代码不同步」时给某一格单独注册；其余格子仍用工作区的实时 provider。
 * 数据是"取到多少显示多少"的历史窗口，没有实时 tick（实时只保证同步品种那一套）。
 */

const TF_NAME: Record<string, string> = { '1': 'M1', '5': 'M5', '15': 'M15', '30': 'M15', '60': 'H1', '240': 'H1', '1D': 'H1' };
const DEFAULT_LIMIT = 900;

interface Range { from?: number; to?: number; limit?: number }
interface Bar { time: number; open: number; high: number; low: number; close: number; volume?: number }

export class CellSymbolProvider {
  private cache = new Map<string, { at: number; bars: Bar[] }>();
  constructor(private readonly symbol: string) {}

  async getBars(ticker: string, timeframe: string, range: Range = {}): Promise<Bar[]> {
    const symbol = (ticker || this.symbol || '').toUpperCase();
    const tf = TF_NAME[timeframe];
    if (!symbol || !tf) return [];
    const limit = Math.max(30, Math.min(2000, Math.round(range.limit ?? DEFAULT_LIMIT)));
    // from/to 是毫秒；服务端要秒。有窗口就用窗口，否则按 limit 取最近。
    const hasWindow = Number.isFinite(range.from) && Number.isFinite(range.to) && (range.to as number) > (range.from as number);
    const key = `${symbol}:${tf}:${hasWindow ? `${Math.floor((range.from as number) / 1000)}-${Math.floor((range.to as number) / 1000)}` : `last:${limit}`}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 15000) return hit.bars;
    const params = new URLSearchParams({ symbol, tf, limit: String(limit) });
    if (hasWindow) {
      params.set('from', String(Math.floor((range.from as number) / 1000)));
      params.set('to', String(Math.floor((range.to as number) / 1000)));
    }
    const payload = await api<{ bars: number[][] }>(`/api/market/bars?${params.toString()}`);
    const bars = (payload.bars ?? [])
      .filter((row) => Array.isArray(row) && row.length >= 5)
      .map((row) => ({ time: Number(row[0]) * 1000, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5] ?? 0) }))
      .filter((bar) => Number.isFinite(bar.time) && Number.isFinite(bar.close));
    this.cache.set(key, { at: Date.now(), bars });
    if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value!);
    return bars;
  }

  info() {
    return { name: `cell:${this.symbol}`, label: this.symbol };
  }
}
