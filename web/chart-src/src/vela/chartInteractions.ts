import { registerWidgetAction, type Vela } from '@luxalgo/vela';
import type { ChartCell } from '@luxalgo/vela/workspace';

const PRICE_ONLY_KEY = 'sn-price-only-scale';
const RESET_VISIBLE_BARS = 120;

export function prepareWorkspaceState(document: unknown, provider: string, symbol: string): unknown {
  if (!document || typeof document !== 'object') return document;
  // Clone before stripping preferences that belong to the current workspace.
  const copy = JSON.parse(JSON.stringify(document));
  delete copy.sync;
  if (Array.isArray(copy.charts)) {
    for (const chart of copy.charts) {
      if (!chart || typeof chart !== 'object') continue;
      delete chart.rendererConfig;
      // Vela prefixes a bare symbol with the saved provider when it restores a cell.
      chart.symbol = symbol;
      chart.provider = provider;
    }
  }
  return copy;
}

/** Keep the last visible candle fixed while returning to a readable zoom. */
export function configureViewReset(
  cell: Pick<ChartCell, 'chart' | 'resetView'>,
  readBars: (symbol: string, timeframe: string) => Promise<ReadonlyArray<{ time: number }>>,
): () => void {
  const original = cell.resetView;
  let disposed = false;
  cell.resetView = () => {
    const chart: Vela = cell.chart;
    const range = chart.getVisibleRange();
    chart.renderer.set('autoScale', true);
    if (!range) return;
    const { symbol, timeframe } = chart.market;
    if (!symbol || !timeframe) return;
    void readBars(symbol, timeframe).then(bars => {
      if (disposed || cell.chart !== chart || chart.market.symbol !== symbol || chart.market.timeframe !== timeframe) return;
      const current = chart.getVisibleRange();
      if (!current || current.from !== range.from || current.to !== range.to) return;
      // Count real candles so a weekend or market halt cannot collapse the reset window.
      let left = 0;
      let right = bars.length;
      while (left < right) {
        const mid = (left + right) >>> 1;
        if (bars[mid].time <= range.to) left = mid + 1;
        else right = mid;
      }
      if (left < 2 || bars[left - 1].time !== range.to) return;
      const from = bars[Math.max(0, left - RESET_VISIBLE_BARS)].time;
      chart.setVisibleRange({ from, to: range.to });
    }).catch(() => { /* Price autoscale is still reset if candle data is unavailable. */ });
  };
  return () => {
    disposed = true;
    cell.resetView = original;
  };
}

/** Start with readable candles; keep the native price-axis switch available. */
export function configurePriceScale(chart: any): () => void {
  let enabled = true;
  try { enabled = localStorage.getItem(PRICE_ONLY_KEY) !== '0'; } catch { /* private browsing */ }
  chart.renderer?.set('scalePriceOnly', enabled);
  return chart.renderer?.onConfigChanged?.(() => {
    const value = chart.renderer?.get('scalePriceOnly');
    if (typeof value === 'boolean') {
      try { localStorage.setItem(PRICE_ONLY_KEY, value ? '1' : '0'); } catch { /* private browsing */ }
    }
  }) ?? (() => {});
}

// Contributions use the cell under the pointer, including when another cell was active.
registerWidgetAction({
  id: 'tongpin-copy-price', target: 'context:body', label: '复制此处价格', order: -90,
  when: ctx => ctx.pointer?.paneKind === 'price' && Number.isFinite(ctx.pointer?.price),
  run: ctx => {
    const price = ctx.pointer?.price;
    if (typeof price !== 'number' || !Number.isFinite(price)) return;
    const text = String(Number(price.toPrecision(12)));
    void navigator.clipboard.writeText(text).then(
      () => ctx.toast(`已复制价格 ${text}`, 'success'),
      () => ctx.toast('复制失败，请检查浏览器剪贴板权限', 'error'),
    );
  },
});

registerWidgetAction({
  id: 'tongpin-price-fit', target: 'context:body', label: '仅按 K 线缩放价格轴', order: 10,
  when: ctx => ctx.chart.renderer.supports('scalePriceOnly'),
  run: ctx => {
    const next = ctx.chart.renderer.get('scalePriceOnly') !== true;
    ctx.chart.renderer.set('scalePriceOnly', next);
    ctx.chart.renderer.set('autoScale', true);
    ctx.toast(next ? '价格轴仅适配 K 线；远处指标仍保留' : '价格轴包含指标范围', 'info');
  },
});
