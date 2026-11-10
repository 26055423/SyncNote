import { useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../../api';
import type { Board } from '../workspace/types';
import type { useLocalTerminal } from '../../localTerminal';
import type { useBackfillBars } from '../../backfillBars';
import type { ChartHandle } from '../../vela/ChartWorkspace';
import type { BaseTimeframe, ReviewCharts } from '../../vela/provider';
import { BASE_SECONDS as TF_SECONDS, mergeLiveHistory } from '../../liveHistory';
import { readTrackPage, readTrackHead, selectTrackSource, type TrackCatalog, type TrackPage } from '../../trackHistory';
import { mergeReviewBars } from '../../reviewHistory';
import { REVIEW_BASE_TFS, MARKET_LIMIT, MARKET_HEAD_POLL_MS, toChartBars } from './model';

interface Options {
 board: Board | null;
 local: ReturnType<typeof useLocalTerminal>;
 backfill: ReturnType<typeof useBackfillBars>;
 marketView: boolean;
 liveSymbol: string;
 connectedTrack: string | null | undefined;
 catalogSource: string | null;
 chartRef: RefObject<ChartHandle | null>;
 forming: { source: string; symbol: string; bars: ReviewCharts } | null;
}

/** Own track cache identity, bootstrap, realtime merging and bounded head refresh. */
export function useMarketHistory({ board, local, backfill, marketView, liveSymbol, connectedTrack, catalogSource, chartRef, forming }: Options) {
  const localConnected = local.phase === 'connected';
  const [liveBars, setLiveBars] = useState<ReviewCharts | null>(null);
  const [marketSeries, setMarketSeries] = useState<ReviewCharts | null>(null);
  const [marketLoadError, setMarketLoadError] = useState('');
  const [marketInfo, setMarketInfo] = useState<{ source: string; server: string; last: number | null; tfs?: TrackCatalog['sources'][number]['tfs'] } | null>(null);
  const trackSourceRef = useRef<string | null>(null);
  const storedTipsRef = useRef<Partial<Record<BaseTimeframe, number>>>({});
  const liveRef = useRef<ReviewCharts>({});
  const liveListeners = useRef(new Set<() => void>());
  const [marketRetry, setMarketRetry] = useState(0);
  const cacheScope = `${board?.user.id ?? ''}:${liveSymbol}:${localConnected ? local.server + ':' + local.epoch : 'cloud'}:${connectedTrack ?? catalogSource ?? ''}`;
  const [loadedCacheScope, setLoadedCacheScope] = useState(cacheScope);
  /* ------------------------------------------------------------ 实时行情 */

  useEffect(() => {
    for (const key of Object.keys(liveRef.current)) delete liveRef.current[key as keyof ReviewCharts];
    setLiveBars(null);
    setMarketSeries(null);
    trackSourceRef.current = null;
    storedTipsRef.current = {};
    setMarketInfo(null);
    setMarketLoadError('');
    setLoadedCacheScope(cacheScope);
  }, [cacheScope]);

  useEffect(() => {
    if (!connectedTrack || (marketInfo?.source && marketInfo.source !== connectedTrack)) return;
    const cloud = marketView && forming?.source === connectedTrack && forming.symbol === liveSymbol ? forming.bars : null;
    if (!localConnected && !cloud) return;
    // 蜡烛直接使用 MT5 的 OHLC；买卖报价由独立的 tick 消息更新。
    const incoming = localConnected ? toChartBars(local.bars) : { ...cloud };
    const previousTips: Partial<Record<BaseTimeframe, number>> = {};
    for (const base of REVIEW_BASE_TFS) {
      const rows = incoming[base];
      if (!rows) continue;
      const current = liveRef.current[base]?.at(-1);
      const candidates = current ? rows.slice(-1) : rows;
      incoming[base] = candidates.filter(row => row[0] > (storedTipsRef.current[base] ?? 0) && row !== current);
      const latest = incoming[base]?.at(-1);
      if (current && latest && latest[0] > current[0]) previousTips[base] = current[0];
    }
    if (!Object.values(incoming).some(rows => rows?.length)) return;
    // 只有追加新蜡烛才需要保存可见范围，盘中价格变化直接更新图表。
    const keepRanges = marketView && Object.keys(previousTips).length ? chartRef.current?.captureRanges() : undefined;
    mergeLiveHistory(liveRef.current, incoming);
    setLiveBars(liveRef.current);
    for (const listener of liveListeners.current) listener();
    if (!keepRanges) return;
    // 用更新前的尾部判断用户是否在翻历史，避免跨休市或补齐大段数据时冻结在旧尾部。
    const frozen: Record<string, { from: number; to: number }> = {};
    for (const [id, range] of Object.entries(keepRanges)) {
      const previous = previousTips[range.base];
      const tfSec = TF_SECONDS[range.base];
      if (previous !== undefined && range.to < (previous - 8 * tfSec) * 1000) frozen[id] = { from: range.from, to: range.to };
    }
    if (Object.keys(frozen).length) requestAnimationFrame(() => chartRef.current?.restoreRanges(frozen));
  }, [marketView, localConnected, connectedTrack, marketInfo?.source, liveSymbol, forming, local.bars, local.history_ready]);

  // 旧 /api/live 内存缓存没有原生 source/symbol 身份，不能拿来给轨道补历史。
  // 未连接本机时直接读取已入库轨道，避免换绑账户或品种后混入旧缓存。

  useEffect(() => {
    // 历史首屏始终读当前数据轨道，不受 EA 是否在线或首批缓存深度限制。
    if (!marketView || !board?.user.id) return;
    let alive = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const catalogRequest = api<TrackCatalog>('/api/data/sources', undefined, { signal: controller.signal }).catch(() => null);
        const knownSource = connectedTrack ?? (localConnected ? null : catalogSource);
        const catalog = knownSource ? null : await catalogRequest;
        if (!alive) return;
        const source = knownSource ?? (!localConnected && catalog ? selectTrackSource(catalog, liveSymbol) : null);
        if (!source) {
          if (!localConnected) {
            for (const key of Object.keys(liveRef.current)) delete liveRef.current[key as BaseTimeframe];
            setLiveBars(null);
          }
          trackSourceRef.current = null; setMarketSeries(null); setMarketInfo(null);
          if (!localConnected) setMarketLoadError(catalog ? '当前轨道尚未入库这个品种的行情。' : '暂时无法读取行情数据源，稍后重试。');
          return;
        }
        if (trackSourceRef.current && trackSourceRef.current !== source) {
          for (const key of Object.keys(liveRef.current)) delete liveRef.current[key as BaseTimeframe];
          setLiveBars(null);
          setMarketSeries(null);
          setMarketInfo(null);
          storedTipsRef.current = {};
        }
        trackSourceRef.current = source;
        const results = await Promise.allSettled(REVIEW_BASE_TFS.map((base) => readTrackPage((path) => api<TrackPage>(path, undefined, { signal: controller.signal }), {
          source, symbol: liveSymbol, base, limit: MARKET_LIMIT[base],
        })));
        if (!alive || trackSourceRef.current !== source) return;
        const pages = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
        const out: ReviewCharts = {};
        for (const page of pages) if (page.bars.length) {
          const base = page.tf as BaseTimeframe;
          out[base] = page.bars;
          storedTipsRef.current[base] = page.bars.at(-1)![0];
        }
        mergeLiveHistory(liveRef.current, out);
        setMarketSeries(Object.keys(out).length ? out : null);
        setMarketInfo({ source, server: pages[0]?.feed?.server ?? '', last: Math.max(0, ...pages.map((page) => page.last_bar ?? 0)) || null });
        setMarketLoadError(pages.length < results.length ? '暂时无法读取部分轨道行情，后台会重试。' : '');
        if (Object.keys(liveRef.current).length) { setLiveBars(liveRef.current); }
        void catalogRequest.then(data => {
          if (!alive || trackSourceRef.current !== source) return;
          const tfs = data?.sources.find(track => track.id === source && track.symbol === liveSymbol)?.tfs;
          if (tfs) setMarketInfo(info => info?.source === source ? { ...info, tfs } : info);
        });
        await Promise.all(REVIEW_BASE_TFS.map((base) => out[base]?.length ? chartRef.current?.applySeries(base, liveRef.current[base]!) : undefined));
      } catch (error) {
        if (alive) setMarketLoadError(`轨道历史读取失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return () => {
      alive = false; controller.abort();
    };
  }, [marketView, localConnected, local.server, local.epoch, liveSymbol, board?.user.id, connectedTrack, catalogSource, marketRetry]);
  useEffect(() => {
    if (!marketView || !board?.user.id || marketInfo?.source) return;
    const timer = window.setInterval(() => setMarketRetry((revision) => revision + 1), 15000);
    return () => window.clearInterval(timer);
  }, [marketView, board?.user.id, marketInfo?.source]);

  // 补采入库后刷新轨道尾部。通常每周期只取两根，发现落后一段才拉近期窗口补齐。
  const refreshTrackRef = useRef<((forceRecent?: boolean) => void) | null>(null);
  useEffect(() => {
    const source = marketInfo?.source;
    if (!marketView || !source) return;
    let alive = true;
    const controller = new AbortController();
    let refreshing = false, pendingRecent = false;
    let catalogAt = 0;
    const refresh = async (forceRecent = false) => {
      if (refreshing) { pendingRecent ||= forceRecent; return; }
      refreshing = true;
      try {
        const results = await Promise.allSettled(REVIEW_BASE_TFS.map((base) => readTrackHead((path) => api<TrackPage>(path, undefined, { signal: controller.signal }), {
          source, symbol: liveSymbol, base, period: TF_SECONDS[base], storedTip: storedTipsRef.current[base],
          forceRecent: forceRecent || (!liveRef.current[base]?.length && storedTipsRef.current[base] === undefined),
        })));
        if (!alive || trackSourceRef.current !== source) return;
        const pages = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
        const changed: BaseTimeframe[] = [];
        for (const page of pages) {
          if (!page.bars.length) continue;
          const base = page.tf as BaseTimeframe;
          const previous = liveRef.current[base] ?? [];
          const merged = mergeReviewBars(previous, page.bars);
          storedTipsRef.current[base] = page.bars.at(-1)![0];
          if (merged !== previous) {
            liveRef.current[base] = merged;
            changed.push(base);
          }
        }
        await Promise.all(changed.map((base) => chartRef.current?.applySeries(base, liveRef.current[base]!, undefined, true, true)));
        if (!alive || trackSourceRef.current !== source) return;
        setMarketInfo((info) => info?.source === source ? { ...info,
          last: Math.max(info.last ?? 0, ...pages.map((page) => page.last_bar ?? 0)) || null } : info);
        if (Object.values(liveRef.current).some((rows) => rows?.length)) setLiveBars(liveRef.current);
        if (pages.length === results.length) setMarketLoadError('');
        for (const listener of liveListeners.current) listener();
        if (forceRecent || Date.now() - catalogAt > 60000) {
          const catalog = await api<TrackCatalog>('/api/data/sources', undefined, { signal: controller.signal });
          if (!alive || trackSourceRef.current !== source) return;
          catalogAt = Date.now();
          const entry = catalog.sources.find((track) => track.id === source && track.symbol === liveSymbol);
          if (entry) setMarketInfo((info) => info?.source === source ? { ...info, tfs: entry.tfs } : info);
        }
      } catch (error) { console.warn('[track-head] 轨道近期数据刷新失败，稍后重试', error); }
      finally {
        refreshing = false;
        if (pendingRecent && alive) { pendingRecent = false; void refresh(true); }
      }
    };
    refreshTrackRef.current = (forceRecent) => { void refresh(forceRecent); };
    const initial = window.setTimeout(() => void refresh(), 700);
    const timer = window.setInterval(() => void refresh(), MARKET_HEAD_POLL_MS);
    return () => { alive = false; controller.abort(); refreshTrackRef.current = null; window.clearTimeout(initial); window.clearInterval(timer); };
  }, [cacheScope, marketView, marketInfo?.source, liveSymbol]);
  const previousBackfillPhase = useRef(backfill.phase);
  const previousRepairUpdated = useRef(backfill.repairUpdated);
  const forceTrackRefreshRef = useRef(false);
  useEffect(() => {
    const completed = previousBackfillPhase.current === 'initializing' && (backfill.phase === 'ready' || backfill.phase === 'partial_ready');
    const repaired = backfill.repairUpdated !== null && backfill.repairUpdated !== previousRepairUpdated.current;
    previousBackfillPhase.current = backfill.phase;
    previousRepairUpdated.current = backfill.repairUpdated;
    forceTrackRefreshRef.current ||= completed || repaired;
    const timer = window.setTimeout(() => {
      const forceRecent = forceTrackRefreshRef.current;
      forceTrackRefreshRef.current = false;
      refreshTrackRef.current?.(forceRecent);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [backfill.phase, backfill.lastUpdated, backfill.repairUpdated]);

  return { liveBars, setLiveBars, marketSeries, marketInfo, marketLoadError, trackSourceRef, storedTipsRef, liveRef, liveListeners, setMarketRetry, cacheScope, loadedCacheScope, refreshTrackRef };
}
