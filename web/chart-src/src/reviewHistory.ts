import type { BaseTimeframe } from './vela/provider';

export type ReviewScope = { shareId: number | null; noteId?: string | null; person?: string; ticket?: string; source?: string | null; symbol?: string };
export type ReviewPage = { bars: number[][]; has_more?: boolean; source?: string; symbol?: string; tf?: string };
export type ReviewDirection = 'left' | 'right' | 'latest';

function reviewQuery(scope: ReviewScope, base: BaseTimeframe): URLSearchParams {
  const params = new URLSearchParams({ tf: base });
  if (scope.shareId != null) params.set('share', String(scope.shareId));
  else if (scope.noteId) params.set('note', scope.noteId);
  else if (scope.person && scope.ticket) {
    params.set('person', scope.person);
    params.set('ticket', scope.ticket);
  } else throw new Error('请先选择一笔交易');
  return params;
}

async function readPage(read: <T>(url: string) => Promise<T>, scope: ReviewScope, base: BaseTimeframe, params: URLSearchParams): Promise<ReviewPage> {
  const page = await read<ReviewPage>('/api/chart/bars?' + params.toString());
  if (scope.source && (page.source !== scope.source || page.symbol !== scope.symbol || page.tf !== base)) {
    throw new Error('复盘行情轨道已变化，请重新打开复盘');
  }
  return page;
}

/** Review access is tied to the trade/share; never fall back to a public market track. */
export async function readReviewPage(
  read: <T>(url: string) => Promise<T>, scope: ReviewScope, base: BaseTimeframe,
  direction: ReviewDirection, rows: number[][], limit = 2000,
): Promise<ReviewPage> {
  const params = reviewQuery(scope, base);
  params.set('limit', String(limit));
  if (direction === 'left' && rows.length) params.set('before', String(rows[0][0]));
  if (direction === 'right' && rows.length) params.set('after', String(rows[rows.length - 1][0]));
  return readPage(read, scope, base, params);
}

export async function readReviewRange(
  read: <T>(url: string) => Promise<T>, scope: ReviewScope, base: BaseTimeframe, from: number, to: number,
): Promise<ReviewPage> {
  const params = reviewQuery(scope, base);
  params.set('from', String(Math.floor(from)));
  params.set('to', String(Math.ceil(to)));
  return readPage(read, scope, base, params);
}

/** The two loaded windows can meet on screen even when days between them are still unloaded. */
export function visibleReviewGap(rows: number[][], from: number, to: number, period: number) {
  let left = 0;
  let right = rows.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (rows[middle][0] <= from) left = middle + 1;
    else right = middle;
  }
  for (let index = Math.max(1, left); index < rows.length; index += 1) {
    const previous = rows[index - 1][0];
    const next = rows[index][0];
    if (previous >= to) break;
    if (next <= to && next - previous > period * 3) return { from: previous, to: next };
  }
  return undefined;
}

export function mergeReviewBars(current: number[][], incoming: number[][]): number[][] {
  if (!incoming.length) return current;
  const rows: number[][] = [];
  let i = 0;
  let j = 0;
  let changed = false;
  while (i < current.length && j < incoming.length) {
    const old = current[i];
    const next = incoming[j];
    if (old[0] < next[0]) { rows.push(old); i += 1; }
    else if (old[0] > next[0]) { rows.push(next); j += 1; changed = true; }
    else {
      const same = old.length === next.length && old.every((value, index) => value === next[index]);
      rows.push(same ? old : next);
      changed ||= !same;
      i += 1;
      j += 1;
    }
  }
  if (!changed && j === incoming.length) return current;
  return rows.concat(current.slice(i), incoming.slice(j));
}
