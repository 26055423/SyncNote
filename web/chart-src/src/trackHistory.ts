import type { BaseTimeframe } from './vela/provider';

export interface TrackCatalog {
  personal: string | null;
  sources: Array<{ id: string; server: string; symbol: string; tfs?: Partial<Record<BaseTimeframe, { bars: number; from: number; to: number }>> }>;
}
export interface TrackPage {
  source: string;
  tf: string;
  bars: number[][];
  has_more: boolean;
  earliest: number | null;
  next_before: number | null;
  feed?: { source: string; server: string };
  last_bar?: number | null;
}

// Same page lifetime as Vela's shared BarStore. Never reuse a key for another source.
const providerNames = new Map<string, string>();
let nextProviderId = 0;
/** Short display-friendly keys, with exact case-sensitive source identity in the map. */
export function trackProviderName(source: string): string {
  let name = providerNames.get(source);
  if (!name) { name = 'sntrack' + (++nextProviderId).toString(36); providerNames.set(source, name); }
  return name;
}

/** Select one stored broker track; a connected terminal must not borrow another broker. */
export function selectTrackSource(catalog: TrackCatalog, symbol: string, server?: string): string | null {
  if (server) return catalog.sources.find((track) => track.symbol === symbol && track.server === server)?.id ?? null;
  return catalog.personal ?? catalog.sources.find((track) => track.symbol === symbol)?.id ?? null;
}

/** Historical charts read stored rows, including across long gaps, without an EA connection. */
export async function readTrackPage(
  read: (path: string) => Promise<TrackPage>,
  request: { source: string; symbol: string; base: BaseTimeframe; limit: number; before?: number },
): Promise<TrackPage> {
  const params = new URLSearchParams({ source: request.source, symbol: request.symbol, tf: request.base, limit: String(request.limit) });
  if (request.before !== undefined) params.set('before', String(request.before));
  const page = await read('/api/market/bars?' + params);
  if (page.source !== request.source || page.tf !== request.base || !Array.isArray(page.bars)) throw new Error('历史行情轨道不一致，请重新加载。');
  let previous = -Infinity;
  for (const row of page.bars) {
    if (!Array.isArray(row) || row.length < 5 || !row.slice(0, 5).every(Number.isFinite)
      || row[0] <= previous || (request.before !== undefined && row[0] >= request.before)) throw new Error('历史行情分页范围不正确。');
    previous = row[0];
  }
  return page;
}
