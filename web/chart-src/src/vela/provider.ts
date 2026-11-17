import type { DataProvider } from '@luxalgo/vela';

/**
 * 同频图表使用同一券商轨道的七个原生周期，时间由服务端统一换算为 UTC。
 * 缓存原位更新，切换周期仍能读取补齐后的数据。
 * M30 / H4 / D1 直接读取各自的原生 K 线，保留券商的开盘边界；
 * 不用低周期聚合补齐未同步的数据。
 */

export type BaseTimeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1';
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
  '30': { base: 'M30', seconds: 1800, minBars: 1 },
  '60': { base: 'H1', seconds: 3600, minBars: 1 },
  '240': { base: 'H4', seconds: 14400, minBars: 1 },
  '1D': { base: 'D1', seconds: 86400, minBars: 1 },
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
    /** 图例里显示的数据源名：复盘是 review，行情页的历史兜底是 market。 */
    private readonly providerName: string = 'review',
  ) {}

  /** 周期菜单只列真正拿得到 K 线的周期。 */
  get availableTimeframes(): string[] {
    return Object.keys(TIMEFRAMES).filter((tf) => this.barsFor(tf).length >= 2);
  }

  info() {
    return {
      // name 是图例里显示的短名；provider 注册键仍在 ChartWorkspace 里单独使用。
      name: this.providerName === 'market' ? '历史行情' : this.providerName === 'review' ? '复盘' : this.providerName,
      displayName: this.providerName === 'market' ? '同频历史行情' : '同频复盘行情',
      supportedTimeframes: this.availableTimeframes,
      capabilities: { enumerate: true, stream: false, symbolInfo: false },
    };
  }

  async listSymbols() {
    return [{ ticker: this.symbol, description: this.symbol }];
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
  return { M1: '1', M5: '5', M15: '15', M30: '30', H1: '60', H4: '240', D1: '1D' }[base];
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
      name: '行情',
      displayName: '同频实时行情',
      supportedTimeframes: Object.keys(TIMEFRAMES),
      capabilities: { enumerate: true, stream: true, symbolInfo: false },
    };
  }

  async listSymbols() {
    return [{ ticker: this.symbol, description: this.symbol }];
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
