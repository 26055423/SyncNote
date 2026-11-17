import type { ReviewCharts } from '../../vela/provider';

export const REVIEW_BASE_TFS = ['M1', 'M5', 'M15', 'H1', 'M30', 'H4', 'D1'] as const;
export const MARKET_HEAD_POLL_MS = 5000;
/* 行情页一次取多少根（最新 N 根）：这条轨有多少就给多少，按根数而不是按天数。 */
export const MARKET_LIMIT: Record<(typeof REVIEW_BASE_TFS)[number], number> = {
  M1: 6000,
  M5: 6000,
  M15: 6000,
  H1: 6000,
  M30: 6000,
  H4: 6000,
  D1: 6000,
};

const LIVE_KEYS: Record<string, (typeof REVIEW_BASE_TFS)[number]> = { '1m': 'M1', '5m': 'M5', '15m': 'M15', '1h': 'H1', '30m': 'M30', '4h': 'H4', '1d': 'D1' };

/** 将七个本机原生周期映射到图表缓存。 */
export function toChartBars(bars: Record<string, number[][]> | undefined): ReviewCharts {
  const out: ReviewCharts = {};
  for (const [key, rows] of Object.entries(bars || {})) {
    const mapped = LIVE_KEYS[key];
    if (mapped && Array.isArray(rows)) out[mapped] = rows;
  }
  return out;
}
