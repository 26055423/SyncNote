import type { ReviewScope } from './reviewHistory';

type Scope = { review: ReviewScope } | { source: string; symbol: string };
/** Use the chart's authorized broker track, never a public or guessed provider. */
export async function readIndicatorMinutes(
  read: (url: string) => Promise<{ bars: number[][]; has_more?: boolean }>,
  scope: Scope, endMs: number, count: number,
): Promise<number[][]> {
  if (!Number.isFinite(endMs) || !Number.isFinite(count) || count < 1) return [];
  let before = Math.floor(endMs / 1000);
  const wanted = Math.min(100000, Math.max(1, Math.round(count)));
  const rows: number[][] = [];
  while (rows.length < wanted) {
    const params = new URLSearchParams({ tf: 'M1', limit: String(Math.min(20000, wanted - rows.length)), before: String(before) });
    let route: string;
    if ('review' in scope) {
      if (scope.review.shareId != null) params.set('share', String(scope.review.shareId));
      else if (scope.review.noteId) params.set('note', scope.review.noteId);
      else if (scope.review.person && scope.review.ticket) {
        params.set('person', scope.review.person); params.set('ticket', scope.review.ticket);
      } else throw new Error('请先选择一笔交易');
      route = '/api/chart/bars';
    } else {
      params.set('source', scope.source); params.set('symbol', scope.symbol);
      route = '/api/market/bars';
    }
    const page = await read(route + '?' + params);
    let previous = -Infinity;
    for (const row of page.bars) {
      if (row.length < 5 || !row.slice(0, 5).every(Number.isFinite) || row[0] <= previous || row[0] >= before)
        throw new Error('hidden OB 一分钟历史顺序或范围错误');
      previous = row[0];
    }
    if (!page.bars.length) break;
    rows.unshift(...page.bars);
    before = page.bars[0]![0];
    if (page.has_more === false) break;
  }
  return rows;
}
