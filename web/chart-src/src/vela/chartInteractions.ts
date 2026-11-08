import { registerWidgetAction } from '@luxalgo/vela';

const PRICE_ONLY_KEY = 'sn-price-only-scale';

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
