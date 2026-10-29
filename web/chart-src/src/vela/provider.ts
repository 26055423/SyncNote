import type { DataProvider } from '@luxalgo/vela';

/**
 * 同频复盘图表的行情来源。
 *
 * 数据来自后端 `journal.review`：每笔交易在 MT5 同步时上传的四组 K 线
 * （M1/M5/M15/H1，UTC 秒），没有 MT5 时是 Dukascopy 参考行情。
 * 页面上不新增行情接口，也不做实时推送——复盘看的是已经发生的那段行情。
 *
 * 30m 从 M15 聚合、4h 和 1D 从 H1 聚合；聚合不出足够 K 线的周期不会出现在
 * 周期菜单里（见 `availableTimeframes`）。
 */

export type BaseTimeframe = 'M1' | 'M5' | 'M15' | 'H1';
export type ReviewCharts = Partial<Record<BaseTimeframe, number[][]>>;

interface Recipe {
  base: BaseTimeframe;
  /** 目标周期秒数 */
  seconds: number;
  /** 至少需要多少根基础 K 线才认为这个周期可用 */
  minBars: number;
}

export const TIMEFRAMES: Record<string, Recipe> = {
  '1': { base: 'M1', seconds: 60, minBars: 1 },
  '5': { base: 'M5', seconds: 300, minBars: 1 },
  '15': { base: 'M15', seconds: 900, minBars: 1 },
  '30': { base: 'M15', seconds: 1800, minBars: 4 },
  '60': { base: 'H1', seconds: 3600, minBars: 1 },
  '240': { base: 'H1', seconds: 14400, minBars: 4 },
  '1D': { base: 'H1', seconds: 86400, minBars: 24 },
};

export const TF_LABEL: Record<string, string> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '30': '30m',
  '60': '1h',
  '240': '4h',
  '1D': '1D',
};

export function timeframeMinutes(tf: string): number | null {
  const match = /^(\d*)\s*([smhdwMy])?$/.exec(tf.trim());
  if (!match) return null;
  const count = match[1] ? Number(match[1]) : 1;
  const unit = match[2] ?? 'm';
  if (unit === 'm') return count;
  if (unit === 'h') return count * 60;
  if (unit === 'd') return count * 1440;
  if (unit === 's') return count / 60;
  if (unit === 'w') return count * 10080;
  return null;
}

/** 把基础周期的 UTC 秒 K 线聚合成更大的周期。 */
export function aggregate(bars: readonly number[][], seconds: number): number[][] {
  const out: number[][] = [];
  for (const bar of bars) {
    const start = Math.floor(bar[0] / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last[0] === start) {
      last[2] = Math.max(last[2], bar[2]);
      last[3] = Math.min(last[3], bar[3]);
      last[4] = bar[4];
    } else {
      out.push([start, bar[1], bar[2], bar[3], bar[4], bar[5] ?? 0]);
    }
  }
  return out;
}

export class ReviewProvider implements DataProvider {
  constructor(
    private readonly charts: ReviewCharts,
    private readonly symbol: string,
  ) {}

  /** 周期菜单只列真正拿得到 K 线的周期。 */
  get availableTimeframes(): string[] {
    return Object.keys(TIMEFRAMES).filter((tf) => this.barsFor(tf).length >= 2);
  }

  info() {
    return {
      name: 'review',
      displayName: '同频复盘行情',
      supportedTimeframes: this.availableTimeframes,
      capabilities: { enumerate: true, stream: false, symbolInfo: false },
    };
  }

  async listSymbols() {
    return [{ ticker: this.symbol, description: 'Gold / US Dollar', type: 'commodity' }];
  }

  async getBars(_ticker: string, timeframe: string): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
    return this.barsFor(timeframe).map((bar) => ({
      time: bar[0] * 1000,
      open: bar[1],
      high: bar[2],
      low: bar[3],
      close: bar[4],
      volume: bar[5] ?? 0,
    }));
  }

  // 复盘是历史行情，没有实时订阅：返回一个空退订函数即可。
  subscribe(): () => void {
    return () => undefined;
  }

  private barsFor(timeframe: string): number[][] {
    const recipe = TIMEFRAMES[timeframe];
    if (!recipe) return [];
    const base = this.charts[recipe.base] ?? [];
    if (!base.length) return [];
    const step = recipe.seconds;
    const baseStep = TIMEFRAMES[basePeriodKey(recipe.base)]?.seconds ?? 60;
    const bars = step === baseStep ? base : aggregate(base, step);
    return bars.length >= Math.min(recipe.minBars, base.length) ? bars : [];
  }
}

function basePeriodKey(base: BaseTimeframe): string {
  return base === 'M1' ? '1' : base === 'M5' ? '5' : base === 'M15' ? '15' : '60';
}

/**
 * 实时行情 provider：各窗格共享页面缓存和更新通知，不再各自发 HTTP 请求。
 */
export class LiveProvider implements DataProvider {
  constructor(
    private readonly initial: ReviewCharts,
    private readonly symbol: string,
    private readonly watch: (listener: () => void) => () => void,
  ) {}

  info() {
    return {
      name: 'live',
      displayName: '同频实时行情',
      supportedTimeframes: Object.keys(TIMEFRAMES),
      capabilities: { enumerate: true, stream: true, symbolInfo: false },
    };
  }

  async listSymbols() {
    return [{ ticker: this.symbol, description: 'Gold / US Dollar', type: 'commodity' }];
  }

  async getBars(_ticker: string, timeframe: string): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
    const recipe = TIMEFRAMES[timeframe];
    if (!recipe) return [];
    const base = this.initial[recipe.base] ?? [];
    if (!base.length) return [];
    const bars = recipe.seconds === (TIMEFRAMES[basePeriodKey(recipe.base)]?.seconds ?? 60) ? base : aggregate(base, recipe.seconds);
    return bars.map(toOhlcv);
  }

  subscribe(_ticker: string, timeframe: string, onBar: (bar: { time: number; open: number; high: number; low: number; close: number; volume: number }) => void): () => void {
    const recipe = TIMEFRAMES[timeframe];
    if (!recipe) return () => undefined;
    return this.watch(() => {
      const base = this.initial[recipe.base] ?? [];
      const rows = recipe.seconds === (TIMEFRAMES[basePeriodKey(recipe.base)]?.seconds ?? 60) ? base : aggregate(base, recipe.seconds);
      const last = rows[rows.length - 1];
      if (last) onBar(toOhlcv(last));
    });
  }
}

function toOhlcv(bar: number[]) {
  return { time: bar[0] * 1000, open: bar[1], high: bar[2], low: bar[3], close: bar[4], volume: bar[5] ?? 0 };
}
