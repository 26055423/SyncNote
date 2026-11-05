type Range = { from: number; to: number };
interface PanChart {
  getVisibleRange(): Range | null;
  panBy(fraction: number): unknown;
  renderer?: { get(key: string): unknown; set(key: string, value: unknown): unknown };
}

/** Pan through the public API: a calendar range may span only two bars across a gap. */
export function panChartByTime(chart: PanChart, delta: number): boolean {
  const range = chart.getVisibleRange();
  const span = range ? range.to - range.from : 0;
  if (!Number.isFinite(delta) || !Number.isFinite(span) || span <= 0 || delta === 0) return false;
  // Synchronous pans let the workspace ignore their echoes and keep dragging responsive.
  const animated = chart.renderer?.get('animScroll');
  const shouldPause = animated === true || (typeof animated === 'number' && animated > 0);
  try {
    if (shouldPause) chart.renderer?.set('animScroll', false);
    chart.panBy(delta / span);
    return true;
  } finally {
    if (shouldPause) chart.renderer?.set('animScroll', animated);
  }
}

export function centerChartOnTime(chart: PanChart, at: number): boolean {
  const range = chart.getVisibleRange();
  return Boolean(range && panChartByTime(chart, at - (range.from + range.to) / 2));
}

/** Data reloads keep native bar spacing; restore the left anchor without fitting a range. */
export function restoreChartLeft(chart: PanChart, from: number): void {
  if (!Number.isFinite(from)) return;
  for (let i = 0; i < 6; i += 1) {
    const before = chart.getVisibleRange();
    if (!before || Math.abs(before.from - from) < 1) return;
    if (!panChartByTime(chart, from - before.from)) return;
    if (chart.getVisibleRange()?.from === before.from) return; // A data boundary cannot move.
  }
}
