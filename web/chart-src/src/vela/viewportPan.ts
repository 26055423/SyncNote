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
  panFraction(chart, delta / span);
  return true;
}

function panFraction(chart: PanChart, fraction: number): void {
  // Synchronous pans let the workspace ignore their echoes and keep dragging responsive.
  const animated = chart.renderer?.get('animScroll');
  const shouldPause = animated === true || (typeof animated === 'number' && animated > 0);
  try {
    if (shouldPause) chart.renderer?.set('animScroll', false);
    chart.panBy(fraction);
  } finally {
    if (shouldPause) chart.renderer?.set('animScroll', animated);
  }
}

export function centerChartOnTime(chart: PanChart, at: number): boolean {
  // 一次 panBy 在远距离跳转时容易被数据边界钳住，迭代几次收敛到目标附近。
  for (let i = 0; i < 8; i += 1) {
    const range = chart.getVisibleRange();
    if (!range || !(range.to > range.from)) return false;
    const span = range.to - range.from;
    const delta = at - (range.from + range.to) / 2;
    if (Math.abs(delta) <= span * 0.02) return true;
    if (!panChartByTime(chart, delta)) return false;
    const next = chart.getVisibleRange();
    if (!next || Math.abs(next.from - range.from) < 1) return true;
  }
  return true;
}

/** Data reloads keep native bar spacing; restore the left anchor without fitting a range. */
export function restoreChartLeft(chart: PanChart, from: number): void {
  if (!Number.isFinite(from)) return;
  let step = 1;
  let previousDirection = 0;
  let bracketed = false;
  // Calendar distance is not screen distance across a weekend. Search by screen
  // fractions instead; once bracketed, converge without ever changing bar spacing.
  for (let i = 0; i < 40; i += 1) {
    const before = chart.getVisibleRange();
    if (!before || Math.abs(before.from - from) < 1) return;
    const direction = Math.sign(from - before.from);
    if (previousDirection && direction !== previousDirection) bracketed = true;
    if (bracketed) step /= 2;
    panFraction(chart, direction * step);
    const after = chart.getVisibleRange();
    if (!after) return;
    // Once sub-bar pans stop changing the rounded visible bar, a bar-level anchor
    // is as close as the public range API can represent.
    if (after.from === before.from && step < 1e-5) return;
    previousDirection = direction;
    if (!bracketed) step *= 2;
  }
}
