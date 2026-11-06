import type { BaseTimeframe } from './vela/provider';

export type ReviewScope = { shareId: number | null; person?: string; ticket?: string };
export type ReviewPage = { bars: number[][]; has_more?: boolean };
export type ReviewDirection = 'left' | 'right' | 'latest';

/** Review access is tied to the trade/share; never fall back to a public market track. */
export async function readReviewPage(
  read: <T>(url: string) => Promise<T>, scope: ReviewScope, base: BaseTimeframe,
  direction: ReviewDirection, rows: number[][],
): Promise<ReviewPage> {
  const params = new URLSearchParams({ tf: base, limit: '2000' });
  if (scope.shareId != null) params.set('share', String(scope.shareId));
  else if (scope.person && scope.ticket) {
    params.set('person', scope.person);
    params.set('ticket', scope.ticket);
  } else throw new Error('请先选择一笔交易');
  if (direction === 'left' && rows.length) params.set('before', String(rows[0][0]));
  if (direction === 'right' && rows.length) params.set('after', String(rows[rows.length - 1][0]));
  return read<ReviewPage>('/api/chart/bars?' + params.toString());
}

export function mergeReviewBars(current: number[][], incoming: number[][]): number[][] {
  const byTime = new Map<number, number[]>();
  for (const bar of current) byTime.set(bar[0], bar);
  for (const bar of incoming) byTime.set(bar[0], bar);
  return [...byTime.values()].sort((a, b) => a[0] - b[0]);
}
