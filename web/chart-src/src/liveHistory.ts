import type { BaseTimeframe, ReviewCharts } from './vela/provider';

export const BASE_SECONDS: Record<BaseTimeframe, number> = { M1: 60, M5: 300, M15: 900, H1: 3600 };

function lowerBound(rows: number[][], time: number): number {
  let left = 0, right = rows.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (rows[mid][0] < time) left = mid + 1;
    else right = mid;
  }
  return left;
}

/** Patch the recent wire window without discarding history loaded by paging. */
export function mergeLiveHistory(cache: ReviewCharts, incoming: ReviewCharts): void {
  for (const base of Object.keys(incoming) as BaseTimeframe[]) {
    const updates = incoming[base];
    if (!updates?.length) continue;
    const rows = cache[base];
    if (!rows?.length) { cache[base] = updates.slice(); continue; }
    let index = lowerBound(rows, updates[0][0]);
    for (const bar of updates) {
      while (index < rows.length && rows[index][0] < bar[0]) index += 1;
      if (index < rows.length && rows[index][0] === bar[0]) rows[index] = bar;
      else rows.splice(index, 0, bar);
      index += 1;
    }
  }
}

/** A stream only publishes the last candle; older pages must also replace chart data. */
export function prependLiveHistory(
  cache: ReviewCharts, base: BaseTimeframe, older: number[][],
  apply: (base: BaseTimeframe, rows: number[][]) => void,
): boolean {
  const current = cache[base] ?? [];
  const before = current[0]?.[0] ?? Infinity;
  const fresh = new Map<number, number[]>();
  for (const row of older) {
    if (row.length >= 5 && Number.isFinite(row[0]) && row[0] < before) fresh.set(row[0], row);
  }
  if (!fresh.size) return false;
  const merged = [...fresh.values()].sort((a, b) => a[0] - b[0]).concat(current);
  cache[base] = merged;
  apply(base, merged);
  return true;
}
