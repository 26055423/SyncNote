import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DrawingsControl } from '@luxalgo/vela';
import { aggregate, ReviewProvider, TIMEFRAMES, TF_LABEL, timeframeMinutes, type BaseTimeframe, type ReviewCharts } from './provider';
import { registerBigwolf } from './bigwolfNative';
import { prefs, usePrefs } from '../ui/prefs';
import { resolveZone } from '../lib/time';
import { centerChartOnTime, panChartByTime, restoreChartLeft } from './viewportPan';

/**
 * Vela 工作区（多窗格 K 线）在同频里的封装。
 *
 * - 数据：ReviewProvider（这笔交易已同步的四组 K 线）
 * - 画线：Vela 自带用户绘图，`getState()` 的状态文档就是存档格式
 * - 定位：`?t=<UTC 秒>` → 每个格子把视窗挪到那根 K 线附近
 * - 只读：消息里的复盘（别人发来的）隐藏绘图工具栏并锁住所有画线
 * - 外观：主题 / 显示时区 / 图表语言跟着「设置」实时变（`setTheme`/`setTimezone`/`setLocale`）
 */

/** 开平仓标注在深色/浅色底上的配色（浅色底要更深，否则虚线看不见）。 */
function markColors(theme: string): { line: string; buy: string; sell: string; labelEntry: string; labelExit: string } {
  return theme === 'light'
    ? { line: '#b8862b', buy: '#0e7490', sell: '#be1250', labelEntry: '#0e7490', labelExit: '#be1250' }
    : { line: '#e2bd77', buy: '#22d3ee', sell: '#ff5ea8', labelEntry: '#22d3ee', labelExit: '#ff5ea8' };
}

/**
 * 存档里的 `rendererConfig` 记的是**生成存档时那台机器**的主题配色
 * （背景、网格、边框、文字、涨跌色）。回放它会让「面板已换成浅色、K 线还是黑的」，
 * 所以套用前先剥掉：配色只认本站「设置 → 主题」。
 */
function stripTheme(document: unknown, provider?: string, symbol?: string): unknown {
  if (!document || typeof document !== 'object') return document;
  let copy: any;
  try {
    copy = JSON.parse(JSON.stringify(document));
  } catch {
    return document;
  }
  // sync（十字线/周期/绘图联动）是工作台偏好，不属于某笔复盘的存档：
  // 旧文档里可能是 crosshair=false，恢复后会出现"十字线不同步"的怪现象。
  delete copy.sync;
  if (Array.isArray(copy.charts)) {
    for (const chart of copy.charts) {
      if (chart && typeof chart === 'object') {
        delete chart.rendererConfig;
        // 存档只存画线/布局，不存“当时的数据源”。provider 改名或换源时，
        // 旧 symbol 会让 Vela 找不到 provider，整张图会空白。
        if (provider && symbol) chart.symbol = symbol;
      }
    }
  }
  return copy;
}

export interface ReplayUiState {
  available: boolean; active: boolean; playing: boolean; armed: boolean; busy: boolean;
  cursorTime: number | null; clockTime: number | null; remaining: number; intervalMs: number;
}
export interface ChartHandle {
  /** 图表样式（candles/bars/line/area/baseline/heikinashi）。 */
  getPriceStyle(): string;
  setPriceStyle(style: string): void;
  replayStatus(): ReplayUiState;
  replaySelect(): void;
  replayStartFromView(): Promise<void>;
  replayStep(): void;
  replayPlay(intervalMs: number): void;
  replayPause(): void;
  replayStop(): void;

  setLayout(id: string): void;
  getLayout(): string;
  setTimeframe(tf: string): void;
  getTimeframe(): string;
  focus(timestampMs?: number): void;
  toggleSync(kind: SyncKind): void;
  getSyncs(): Partial<Record<SyncKind, boolean>>;
  /** 记下每格可见范围（新 K 线到来前调用）。 */
  captureRanges(): Record<string, { from: number; to: number; base: BaseTimeframe }>;
  /** 把可见范围恢复回去（只恢复传入的格子）。 */
  restoreRanges(ranges: Record<string, { from: number; to: number }>): void;
  snapshot(): unknown;
  flush(): void;
  /** 分享用：激活格子的周期、可见窗口中点（毫秒）、布局，以及当时的画线文档（已去掉开平仓标注）。 */
  view(): { anchor_ms: number; timeframe: string; layout: string; document: unknown } | null;
  /** 激活某个画图工具（再点一次取消）。 */
  useTool(type: string | null): void;
  /** 当前激活的工具类型。 */
  activeTool(): string | null;
  /** 把收藏的工具同步给所有格子的原生工具栏。 */
  setFavorites(types: string[]): void;
  /** 用新的一段 K 线替换某个基础周期，并按各格子的周期重绘（保持视窗）。 */
  applySeries(base: BaseTimeframe, bars: number[][], onlyCellId?: string, refresh?: boolean): Promise<void>;
}

export type SyncKind = 'symbol' | 'timeframe' | 'crosshair' | 'viewport' | 'drawings' | 'style';
/** 「时间轴」开关存在本机：只影响点击跳转，不影响缩放。 */
const TIME_SYNC_KEY = 'sn-time-sync';
/** 「十字线」联动开关也存在本机，默认开。 */
const CROSSHAIR_SYNC_KEY = 'sn-crosshair-sync';

interface Props {
  /** Mount the native style/indicators/undo controls in the shared page header. */
  toolbarHost?: HTMLDivElement | null;
  charts: ReviewCharts;
  symbol: string;
  anchorMs: number;
  savedState: unknown;
  readOnly: boolean;
  timeframes?: string[];
  /** 收藏的画图工具（同步给原生工具栏，显示在顶部）。 */
  favorites?: string[];
  /** 左侧工具栏里收藏变化时回调（顶部栏据此刷新）。 */
  onFavorites?: (types: string[]) => void;
  /** 当前激活的画图工具变化时回调。 */
  onTool?: (type: string | null) => void;
  /** 某个格子的可见范围变了（已节流）：上层据此补段/删段。 */
  onViewport?: (info: { cellId: string; timeframe: string; from: number; to: number }) => void;
  /** 窄屏强制布局（例如手机上一格）：回放存档后再套用一次。 */
  forceLayout?: string;
  /** 复盘时在图上标出开仓/平仓点，并用虚线连接（类似 MT5）。 */
  tradeMarks?: { openedAt: number; closedAt: number; open: number; close: number; side: 'buy' | 'sell' } | null;
  /** 行情模式下用实时 provider 覆盖默认的静态复盘数据源。 */
  provider?: unknown;
  providerName?: string;
  onStateChange?: (document: unknown) => void;
  onTimeframe?: (tf: string) => void;
  onLayout?: (id: string) => void;
  onSyncs?: (syncs: Partial<Record<SyncKind, boolean>>) => void;
  onError?: (message: string) => void;
}

/** 2×2 默认各看一个周期：优先 1m/5m/15m/1h，缺哪个就用还拿得到的周期补位。 */
function seedCells(available: string[] | undefined): Record<string, { timeframe: string }> {
  const wanted = ['1', '5', '15', '60', '30', '240', '1D'].filter((tf) => (available && available.length ? available.includes(tf) : true));
  const list = wanted.length ? wanted : ['15'];
  const cells: Record<string, { timeframe: string }> = {};
  for (let i = 0; i < 4; i += 1) cells['c' + (i + 1)] = { timeframe: list[Math.min(i, list.length - 1)] };
  return cells;
}

export const ChartWorkspace = forwardRef<ChartHandle, Props>(function ChartWorkspace(props, ref) {
  const { charts, symbol, anchorMs, savedState, readOnly, timeframes, onStateChange, onTimeframe, onLayout, onSyncs, onError, onFavorites, onTool } = props;
  // 拖动补段用：数据副本 + 可见范围回调（回调放 ref，避免闭包拿到旧的 props）。
  const dataRef = useRef<ReviewCharts>({ ...(props.charts ?? {}) });
  const viewportRef = useRef(props.onViewport);
  viewportRef.current = props.onViewport;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<any>(null);
  const seriesUpdateUntilRef = useRef(new Map<string, number>());
  const anchorRef = useRef(anchorMs);
  const replayArmedRef = useRef(false);
  const replayBusyRef = useRef(false);
  const replayRequestRef = useRef(0);
  const replayPendingRef = useRef(new Set<BaseTimeframe>());
  const replaying = () => replayArmedRef.current || replayBusyRef.current || Boolean(wsRef.current?.replay?.state.active);
  const showReplayMarks = (visible: boolean) => {
    for (const cell of wsRef.current?.cells?.() ?? []) {
      const drawings: DrawingsControl = cell.chart.drawings;
      for (const id of markIdsByCellRef.current.get(cell.id) ?? []) drawings.show(id, visible);
    }
  };
  const startReplay = async (from: number, cell?: string) => {
    const ws = wsRef.current;
    if (!ws?.replay?.bounds || replayBusyRef.current) return;
    const request = ++replayRequestRef.current;
    replayArmedRef.current = false; replayBusyRef.current = true;
    try {
      showReplayMarks(false);
      const master = (ws.cells() as any[]).find(item => item.id === (cell ?? ws.active?.id));
      const recipe = TIMEFRAMES[master?.chart.market.timeframe ?? '1'];
      const rows = dataRef.current[recipe.base] ?? [];
      const baseSeconds = TIMEFRAMES[basePeriodKey(recipe.base)].seconds;
      const rendered = recipe.seconds === baseSeconds ? rows : aggregate(rows, recipe.seconds);
      const { safeReplayStart } = await import('./replayController');
      if (request !== replayRequestRef.current || wsRef.current !== ws) return;
      await safeReplayStart(ws, { from, cell: master?.id, masterOpenTimes: rendered.map(row => row[0] * 1000) });
      if (request !== replayRequestRef.current || wsRef.current !== ws) return;
      if (!ws.replay.state.active) { showReplayMarks(true); throw new Error('这个位置没有可回放的后续K线，请选择更早的起点。'); }
    } catch (error) {
      if (request !== replayRequestRef.current || wsRef.current !== ws) return;
      showReplayMarks(true); throw error;
    } finally { if (request === replayRequestRef.current) replayBusyRef.current = false; }
  };
  const flushReplayPending = async () => {
    const bases = new Set(replayPendingRef.current); replayPendingRef.current.clear();
    for (const cell of wsRef.current?.cells?.() ?? []) {
      const recipe = TIMEFRAMES[cell.chart.market.timeframe];
      if (!recipe || !bases.has(recipe.base)) continue;
      const rows = dataRef.current[recipe.base] ?? [];
      const step = TIMEFRAMES[basePeriodKey(recipe.base)].seconds;
      const rendered = recipe.seconds === step ? rows : aggregate(rows, recipe.seconds);
      seriesUpdateUntilRef.current.set(cell.id, Infinity);
      try {
        await cell.chart.setMarket(props.provider ? { data: [], bars: Math.max(rendered.length, cell.chart.market.bars ?? 0) + 1 } : { data: rendered.map(toOhlcv) });
        await cell.chart.historyComplete();
      } finally { seriesUpdateUntilRef.current.set(cell.id, Date.now() + 100); }
    }
  };

  const favoritesRef = useRef<string[]>(props.favorites ?? []);
  const markIdsRef = useRef<Set<string>>(new Set());
  const markIdsByCellRef = useRef<Map<string, Set<string>>>(new Map());
  // 分享时要把开平仓标注剔掉，`stripMarks` 定义在初始化闭包里，用 ref 传出来。
  const stripRef = useRef<((document: unknown) => unknown) | null>(null);
  /** 每格自动配对的 MACD 副图 handle：删主图时用它连带删除。 */
  const companionRef = useRef<Map<string, { remove?: () => void }>>(new Map());
  /** 每格是否已经有主图指标：用来判断"主图重新出现"才配对。 */
  const pairStateRef = useRef<Map<string, { hadMain: boolean }>>(new Map());

  /**
   * bigwolf 主图 + MACD 副图的配对。用轮询状态机而不是事件，避免事件时序问题：
   *   主图从无到有 → 自动补副图；
   *   主图从有到无 → 连带删掉我们自动加的副图；
   *   用户手动删掉副图（主图还在）→ 不会再加回来。
   */
  const reconcilePairing = (cell: any) => {
    const chart = cell?.chart;
    if (!chart?.presentNativeIndicators) return;
    const present = new Set<string>(chart.presentNativeIndicators() as string[]);
    const hasMain = present.has('bigwolf');
    const hasMacd = present.has('bigwolf-macd');
    const state = pairStateRef.current.get(cell.id) ?? { hadMain: false };
    if (hasMain && !state.hadMain && !hasMacd) {
      const handle = chart.addNativeIndicator?.('bigwolf-macd');
      companionRef.current.set(cell.id, handle);
    } else if (!hasMain && state.hadMain) {
      const handle = companionRef.current.get(cell.id);
      companionRef.current.delete(cell.id);
      if (handle && hasMacd) {
        try {
          handle.remove?.();
        } catch {
          /* ignore */
        }
      }
    }
    state.hadMain = hasMain;
    pairStateRef.current.set(cell.id, state);
  };
  // 「时间轴同步」= 点击跳到同一时刻（像 TradingView），不是缩放同步。
  // 存在本机，刷新后仍然生效。
  const timeSyncRef = useRef<boolean>((() => {
    // 默认开启：勾掉才完全不联动。
    try { return localStorage.getItem(TIME_SYNC_KEY) !== '0'; } catch { return true; }
  })());
  /** 十字线联动：默认开，勾掉后记在本机。 */
  const crosshairSyncRef = useRef<boolean>((() => {
    try { return localStorage.getItem(CROSSHAIR_SYNC_KEY) !== '0'; } catch { return true; }
  })());
  const stateWithTimeSync = (ws: any): Partial<Record<SyncKind, boolean>> => ({
    ...((ws?.sync?.state?.() ?? {}) as Partial<Record<SyncKind, boolean>>),
    viewport: timeSyncRef.current,
    crosshair: crosshairSyncRef.current,
  });
  /** 把除 exceptId 之外的格子平移到 at 附近，保持实际蜡烛宽度。 */
  const jumpAllTo = (at: number | null, exceptId?: string) => {
    if (at == null) return;
    for (const cell of wsRef.current?.cells?.() ?? []) {
      if (exceptId && cell.id === exceptId) continue;
      programmaticUntilRef.current.set(cell.id, Date.now() + 250);
      try { centerChartOnTime(cell.chart, at); } catch { /* ignore */ }
    }
  };
  const activeCenter = (): number | null => {
    const ws = wsRef.current;
    const cell = ws?.active ?? (ws?.cells?.() ?? [])[0];
    const range = cell?.chart?.getVisibleRange?.();
    if (!range || !(range.to > range.from)) return null;
    return (range.from + range.to) / 2;
  };
  // 拖动联动：记录每格上一次的可见范围，用「时间增量」平移别的格（不是按根数）。
  // 例如 1m 格拖了 60 根 = 60 分钟，15m 格就会平移 60 分钟 = 4 根。
  const lastRangeRef = useRef<Map<string, { from: number; to: number }>>(new Map());
  // 我们自己 panBy 触发的回声要忽略，但只忽略被推的那几格：
  // 按时间窗口一刀切会把源格子自己的连续拖动事件一起吞掉，表现为"拖了半天只跟一下"。
  const programmaticUntilRef = useRef<Map<string, number>>(new Map());
  const gestureUntilRef = useRef<Map<string, number>>(new Map());
  const panOthers = (exceptId: string, delta: number) => {
    if (!delta) return;
    const until = Date.now() + 250;
    for (const other of wsRef.current?.cells?.() ?? []) {
      if (other.id === exceptId) continue;
      const range = other.chart?.getVisibleRange?.();
      if (!range || !(range.to > range.from)) continue;
      programmaticUntilRef.current.set(other.id, until);
      // 原生 panBy 保持实际蜡烛宽度；setVisibleRange 跨缺口会重新缩放。
      try { panChartByTime(other.chart, delta); } catch { /* ignore */ }
    }
  };
  const [ready, setReady] = useState(false);
  const { theme, timezone, chartLocale } = usePrefs();
  // 标注是在事件回调里画的，回调闭包拿不到最新的 props，用 ref 兜住当前主题。
  const themeRef = useRef(theme);
  themeRef.current = theme;

  anchorRef.current = anchorMs;

  useImperativeHandle(ref, () => ({
    getPriceStyle() {
      try { return String(wsRef.current?.active?.chart?.renderer?.get?.('priceStyle') ?? 'candles'); }
      catch { return 'candles'; }
    },
    setPriceStyle(style) {
      try { wsRef.current?.active?.chart?.renderer?.set?.('priceStyle', style); } catch { /* ignore */ }
    },
    replayStatus() {
      const replay = wsRef.current?.replay;
      const state = replay?.state;
      const closes = (wsRef.current?.cells?.() ?? []).map((cell: any) => {
        const at = cell.chart.replay.state.cursorTime;
        const seconds = TIMEFRAMES[cell.chart.market.timeframe]?.seconds;
        return typeof at === 'number' && seconds ? at + seconds * 1000 : 0;
      });
      return { available: Boolean(replay?.bounds), active: Boolean(state?.active), playing: Boolean(state?.playing),
        armed: replayArmedRef.current, busy: replayBusyRef.current,
        cursorTime: state?.cursorTime ?? null, clockTime: state?.active ? Math.max(0, ...closes) || null : null,
        remaining: state?.remaining ?? 0, intervalMs: state?.intervalMs ?? 1000 };
    },
    replaySelect() { wsRef.current?.replay?.pause(); replayArmedRef.current = true; wsRef.current?.active?.chart?.drawings?.setTool(null); },
    async replayStartFromView() {
      const cell = wsRef.current?.active;
      const range = cell?.chart?.getVisibleRange();
      if (range) await startReplay((range.from + range.to) / 2, cell.id);
    },
    replayStep() { wsRef.current?.replay?.pause(); wsRef.current?.replay?.step(); },
    replayPlay(intervalMs) { wsRef.current?.replay?.play(intervalMs); },
    replayPause() { wsRef.current?.replay?.pause(); },
    replayStop() {
      replayRequestRef.current += 1;
      replayArmedRef.current = false; replayBusyRef.current = false;
      wsRef.current?.replay?.stop(); showReplayMarks(true);
      void flushReplayPending().catch(error => onError?.(String(error)));
    },
    setLayout(id) {
      if (replaying()) return;
      try {
        wsRef.current?.setLayout?.(id);
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
      }
    },
    getLayout() {
      try {
        return wsRef.current?.getState?.()?.layout ?? '4';
      } catch {
        return '4';
      }
    },
    setTimeframe(tf) {
      if (replaying()) return;
      const ws = wsRef.current;
      if (!ws) return;
      // 默认只改当前格子；只有布局菜单里打开「周期同步」才应用到全部。
      const all = Boolean(ws.sync?.state?.().timeframe);
      if (all) {
        ws.cells?.().forEach((cell: any) => {
          void cell.chart?.setMarket?.({ timeframe: tf, ...(!props.provider ? { data: [] } : {}) });
        });
      } else {
        void ws.active?.chart?.setMarket?.({ timeframe: tf, ...(!props.provider ? { data: [] } : {}) });
      }
      onTimeframe?.(tf);
    },
    getTimeframe() {
      return wsRef.current?.active?.chart?.market?.timeframe ?? '15';
    },
    focus(timestampMs) {
      if (replaying()) return;
      focusAll(wsRef.current, timestampMs ?? anchorRef.current, timestampMs ? null : props.tradeMarks);
    },
    useTool(type) {
      const api = wsRef.current?.active?.chart?.drawings;
      if (!api) return;
      try {
        api.setTool(type && api.getTool?.() === type ? null : type);
      } catch {
        /* 忽略 */
      }
    },
    activeTool() {
      try {
        return wsRef.current?.active?.chart?.drawings?.getTool?.() ?? null;
      } catch {
        return null;
      }
    },
    setFavorites(types) {
      favoritesRef.current = types;
      for (const cell of wsRef.current?.cells?.() ?? []) {
        try {
          cell.chart?.drawings?.setFavorites?.(types);
        } catch {
          /* 忽略 */
        }
      }
    },
    async applySeries(base, bars, _onlyCellId, refresh = false) {
      // The static provider shares this cache, including newly added/layout-switched cells.
      dataRef.current[base] = bars;
      if (replaying()) { replayPendingRef.current.add(base); return; }
      const updates: Promise<void>[] = [];
      for (const cell of wsRef.current?.cells?.() ?? []) {
        // 同基础周期的每个格子都补齐，各自保持原来的位置与蜡烛宽度。
        const tfId: string = cell.chart?.market?.timeframe ?? '15';
        const recipe = TIMEFRAMES[tfId];
        if (!recipe || recipe.base !== base) continue;
        const source = dataRef.current[recipe.base] ?? [];
        if (!source.length) continue;
        const baseSeconds = TIMEFRAMES[basePeriodKey(recipe.base)]?.seconds ?? 60;
        const rendered = recipe.seconds === baseSeconds ? source : aggregate(source, recipe.seconds);
        const chart = cell.chart;
        const range = chart.getVisibleRange?.();
        updates.push((async () => {
          seriesUpdateUntilRef.current.set(cell.id, Infinity);
          try {
            // Vela 0.9.3 的图表没有 setBars；那是 renderer 的底层接口。
            // 非空离线 data 会停止实时订阅，实时图通常只扩深度。
            if (props.provider) {
              // 空 data 强制从 provider 重载中间缺口，保持实时订阅。
              await chart.setMarket({ ...(refresh ? { data: [] } : {}),
                bars: Math.max(rendered.length + (refresh ? 2 : 0), (chart.market?.bars ?? 0) + (refresh ? 2 : 1)) });
            } else {
              await chart.setMarket({ data: rendered.map(toOhlcv) });
            }
            await chart.historyComplete();
            if (range && (!props.provider || refresh)) restoreChartLeft(chart, range.from);
          } finally { seriesUpdateUntilRef.current.set(cell.id, Date.now() + 100); }
        })());
      }
      await Promise.all(updates);
    },
    toggleSync(kind) {
      const ws = wsRef.current;
      if (!ws) return;
      // 「时间轴」不再是 Vela 的缩放同步：本站只做"点击跳转到同一时刻"，
      // 不同窗口的缩放/平移始终互不影响。开关状态自己记，存在本机。
      if (kind === 'viewport') {
        const next = !timeSyncRef.current;
        timeSyncRef.current = next;
        try { localStorage.setItem(TIME_SYNC_KEY, next ? '1' : '0'); } catch { /* ignore */ }
        if (next) jumpAllTo(activeCenter());
        onSyncs?.(stateWithTimeSync(ws));
        return;
      }
      const state = ws.sync?.state?.() ?? {};
      const next = !state[kind];
      ws.sync?.set?.(kind, next);
      if (kind === 'crosshair') {
        crosshairSyncRef.current = next;
        try { localStorage.setItem(CROSSHAIR_SYNC_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      }
      onSyncs?.(stateWithTimeSync(ws));
    },
    getSyncs() {
      return stateWithTimeSync(wsRef.current);
    },
    /** 记下每格当前的可见范围（新 K 线到来前调用）。 */
    captureRanges() {
      if (replaying()) return {};
      const out: Record<string, { from: number; to: number; base: BaseTimeframe }> = {};
      for (const cell of wsRef.current?.cells?.() ?? []) {
        try {
          const range = cell.chart?.getVisibleRange?.();
          const tfId = cell.chart?.market?.timeframe ?? '15';
          const base = TIMEFRAMES[tfId]?.base;
          if (range && base && Number.isFinite(range.from) && Number.isFinite(range.to)) out[cell.id] = { from: range.from, to: range.to, base };
        } catch { /* ignore */ }
      }
      return out;
    },
    /** 把可见范围恢复回去：新 K 线不该把画面推走。 */
    restoreRanges(ranges: Record<string, { from: number; to: number; base?: BaseTimeframe }>) {
      if (replaying()) return;
      for (const cell of wsRef.current?.cells?.() ?? []) {
        const target = ranges[cell.id];
        if (!target) continue;
        try {
          const now = cell.chart?.getVisibleRange?.();
          if (now && Math.abs(now.from - target.from) < 1 && Math.abs(now.to - target.to) < 1) continue;
          programmaticUntilRef.current.set(cell.id, Date.now() + 250);
          restoreChartLeft(cell.chart, target.from);
        } catch { /* ignore */ }
      }
    },
    snapshot() {
      try {
        return wsRef.current?.getState?.() ?? null;
      } catch {
        return null;
      }
    },
    flush() {
      try {
        wsRef.current?.flushPendingState?.();
      } catch {
        /* ignore */
      }
    },
    view() {
      const ws = wsRef.current;
      if (!ws) return null;
      const cell = ws.active;
      let range: { from?: number; to?: number } | null = null;
      try {
        range = cell?.chart?.getVisibleRange?.() ?? null;
      } catch {
        range = null;
      }
      const from = Number(range?.from);
      const to = Number(range?.to);
      const center = Number.isFinite(from) && Number.isFinite(to) && to > from
        ? Math.round((from + to) / 2)
        : Math.round(anchorRef.current || Date.now());
      let document: unknown = null;
      try {
        const state = ws.getState?.() ?? null;
        document = stripRef.current ? stripRef.current(state) : state;
      } catch {
        document = null;
      }
      let layout = '4';
      try {
        layout = ws.getState?.()?.layout ?? '4';
      } catch {
        /* ignore */
      }
      return { anchor_ms: center, timeframe: cell?.chart?.market?.timeframe ?? '15', layout, document };
    },
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // A rebuilt workspace owns a new native toolbar; remount it once ready.
    setReady(false);
    let disposed = false;

    (async () => {
      try {
        // 先注册自写指标和额外布局，工作区启动后才能在选择器里看到。
        await import('./indicators/pdhpdl');
        await import('./indicators/smc');
        await import('./layouts');
        const [{ registerLocale }, zhHans] = await Promise.all([
          import('@luxalgo/vela'),
          import('@luxalgo/vela/locales/zh-Hans'),
        ]);
        registerLocale((zhHans as any).default);
        const { VelaWorkspace } = await import('@luxalgo/vela/workspace');
        if (disposed || !hostRef.current) return;

        Object.assign(dataRef.current, charts);
        const provider = (props.provider as never) ?? new ReviewProvider(dataRef.current, symbol, props.providerName || 'review');
        const providerName = props.provider ? (props.providerName || 'live') : (props.providerName || 'review');
        const initial = prefs.getState();
        await registerBigwolf();
        const ws = new VelaWorkspace(hostRef.current, {
          layout: '4',
          symbol,
          timeframe: '15',
          cells: seedCells(timeframes),
          live: Boolean(props.provider),
          theme: initial.theme,
          locale: initial.chartLocale,
          // 表格和 K 线时间轴必须用同一个显示时区，否则「复盘跳到这根 K 线」会对不上。
          timezone: resolveZone(initial.timezone),
          providers: { [providerName]: () => provider },
          // Pine 指标引擎 + bigwolf：指标面板里就能添加，不再自己画叠加层。
          // 官方推荐：workspace 里用 Worker 版，脚本再重也不卡 UI。
          sync: { crosshair: crosshairSyncRef.current },
          persist: false,
          drawingToolbar: !readOnly,
          bottombar: false,
          topbar: { left: ['style', 'indicators', 'undo-redo'] },
        }) as any;

        wsRef.current = ws;
        // 调试/端到端检查用：控制台里可以直接看视窗范围、画线存档。
        (window as unknown as Record<string, unknown>).__tpChart = ws;

        if (savedState) {
          try {
            // 存档里带着当时那台机器的配色（rendererConfig 里有背景/网格/文字色）：
            // 直接套用会让"面板已经换成浅色、K 线还是黑的"。主题由本站设置统一决定，
            // 所以回放前把渲染器配置剥掉。
            ws.applyState(stripTheme(savedState, providerName, symbol));
          } catch {
            /* 存档不兼容时退回默认布局，不阻塞看图 */
          }
        }
        // Apply even when a saved document is absent or incompatible.
        if (props.forceLayout) {
          try { ws.setLayout?.(props.forceLayout); } catch { /* ignore */ }
        }
        // 回放后再对齐一次当前主题（布局/存档都可能重建过格子）。
        try {
          ws.setTheme?.(prefs.getState().theme);
        } catch {
          /* ignore */
        }
        // Vela 自带的 viewport 同步会连缩放一起同步，不需要：关掉它，
        // 「时间轴」只由本站的点击跳转实现（timeSyncRef）。
        try { ws.sync?.set?.('viewport', false); } catch { /* ignore */ }
        // 旧存档/旧工作台可能残留 crosshair=false，按本机偏好恢复一次。
        try { ws.sync?.set?.('crosshair', crosshairSyncRef.current); } catch { /* ignore */ }
        onSyncs?.(stateWithTimeSync(ws));

        const focusOne = (cell: any) => {
          if (Date.now() < (seriesUpdateUntilRef.current.get(cell.id) ?? 0)) return;
          const tf = cell?.chart?.market?.timeframe ?? '15';
          const minutes = timeframeMinutes(tf) ?? 15;
          const width = minutes * 60_000;
          const anchor = anchorRef.current;
          if (replaying()) return;
          const marks = props.tradeMarks;
          if (!marks && (!Number.isFinite(anchor) || anchor <= 0)) return;
          try {
            if (marks && marks.openedAt > 0 && marks.closedAt > 0) {
              // 开平仓都要进视野：只按开仓 ±22 根会把持仓超过 22 根的交易平仓点挤出屏幕。
              const start = Math.min(marks.openedAt, marks.closedAt) * 1000;
              const end = Math.max(marks.openedAt, marks.closedAt) * 1000;
              const pad = Math.max(width * 12, (end - start) * 0.25);
              cell.chart.setVisibleRange({ from: start - pad, to: end + pad });
            } else {
              // 开仓那根 K 线落在正中（左右各 22 根），点开复盘第一眼就对着开仓。
              cell.chart.setVisibleRange({ from: anchor - width * 22, to: anchor + width * 22 });
            }
          } catch {
            /* ignore */
          }
        };

        const lockDrawings = (cell: any) => {
          const api = cell?.chart?.drawings;
          if (!api) return;
          try {
            api.showToolbar?.(false);
            if (readOnly) api.all?.().forEach((drawing: { id: string }) => api.lock?.(drawing.id, true));
          } catch {
            /* ignore */
          }
        };

        const annotate = (cell: any) => {
          if (replaying()) return;
          const marks = props.tradeMarks;
          const api = cell?.chart?.drawings;
          if (!marks || !api) return;
          const known = markIdsByCellRef.current.get(cell.id);
          const present = new Set((api.all?.() ?? []).map((row: { id: string }) => row.id));
          if (known && [...known].some((id) => present.has(id))) return;
          // 对齐到这一格 K 线的开盘时间：否则标注会落在两根蜡烛之间（看起来"歪了"）。
          const tfId: string = cell?.chart?.market?.timeframe ?? '15';
          const stepSec = TIMEFRAMES[tfId]?.seconds ?? 900;
          const snap = (ms: number): number => Math.floor(ms / 1000 / stepSec) * stepSec * 1000;
          const opened = snap(marks.openedAt * 1000);
          const closed = snap(marks.closedAt * 1000);
          const palette = markColors(themeRef.current);
          const ids = new Set<string>();
          const keep = (drawing: unknown) => {
            const id = (drawing as { id?: string } | null)?.id;
            if (id) {
              ids.add(id);
              markIdsRef.current.add(id);
            }
          };
          // 三个图元各自 try：加的选项被旧渲染器拒绝时，只丢一个，不会把整套标注弄没。
          try {
            keep(api.add('trendline', {
              anchors: [{ time: opened, price: marks.open }, { time: closed, price: marks.close }],
              style: { lineColor: palette.line, lineWidth: 1, lineStyle: 'dashed' },
            }));
          } catch { /* ignore */ }
          // 标签：高对比色 + 压在最上层，放在蜡烛的上/下方，不压在实体上。
          // Vela 的文字绘图不支持描边/底框（fillColor 会被忽略），所以靠颜色和层序保证可读。
          const addLabel = (anchor: { time: number; price: number }, value: string, align: 'left' | 'right', vAlign: 'top' | 'bottom', color: string) => api.add('text', {
            anchors: [anchor],
            text: { value, size: 'small' as const, bold: true, hAlign: align, vAlign, color },
            zIndex: 2000,
          });
          try { keep(addLabel({ time: opened, price: marks.open }, '开仓 ' + marks.open.toFixed(2), 'left', 'bottom', palette.labelEntry)); } catch { /* ignore */ }
          try { keep(addLabel({ time: closed, price: marks.close }, '平仓 ' + marks.close.toFixed(2), 'left', 'top', palette.labelExit)); } catch { /* ignore */ }
          if (ids.size) markIdsByCellRef.current.set(cell.id, ids);
        };

        const stripMarks = (document: any) => {
          if (!document || !Array.isArray(document.charts)) return document;
          for (const chart of document.charts) {
            const drawings = chart?.drawings;
            if (drawings && Array.isArray(drawings.drawings)) {
              drawings.drawings = drawings.drawings.filter((row: any) => !markIdsRef.current.has(row?.id));
            }
            // 存档不写配色：换主题的人不该把颜色带给同事的复盘和别人的分享。
            if (chart && typeof chart === 'object') delete chart.rendererConfig;
          }
          return document;
        };
        stripRef.current = stripMarks;

        const bind = (cell: any) => {
          if (!cell || cell.__tpBound) return;
          cell.__tpBound = true;
          // A quote or a resize may move the active viewport too; only a real gesture leads.
          cell.host?.addEventListener('pointerdown', () => {
            gestureUntilRef.current.set(cell.id, Infinity);
            programmaticUntilRef.current.delete(cell.id);
          });
          cell.host?.addEventListener('pointerup', () => gestureUntilRef.current.set(cell.id, Date.now() + 400));
          cell.host?.addEventListener('pointercancel', () => gestureUntilRef.current.delete(cell.id));
          cell.host?.addEventListener('wheel', () => gestureUntilRef.current.set(cell.id, Date.now() + 400), { passive: true });
          // 拖动/缩放时把可见范围报上去，由上层决定补哪段、删哪段。
          let lastViewport = 0;
          try {
            // cell.chart 上没有 onViewportChange（那是渲染器接口），
            // 公开事件是 on('viewport:changed')；之前用错 API，联动一直是死代码。
            cell.chart?.on?.('viewport:changed', (range: { from: number; to: number }) => {
              // 拖动联动：先看这一格是「平移」还是「缩放」。
              // 跨度没变 = 平移，把时间增量同步给其他格；跨度变了 = 缩放，不动别人。
              const previous = lastRangeRef.current.get(cell.id);
              const span = range.to - range.from;
              lastRangeRef.current.set(cell.id, { from: range.from, to: range.to });
              if (replaying()) return;
              // Reload/prepend events are data maintenance, not gestures in the active chart.
              if (Date.now() < (seriesUpdateUntilRef.current.get(cell.id) ?? 0)) return;
              const programmaticUntil = programmaticUntilRef.current.get(cell.id) ?? 0;
              const gesturing = Date.now() < (gestureUntilRef.current.get(cell.id) ?? 0);
              if (timeSyncRef.current && gesturing && ws.active?.id === cell.id && Date.now() > programmaticUntil && previous && span > 0) {
                const previousSpan = previous.to - previous.from;
                if (Math.abs(previousSpan - span) < 1) {
                  const delta = range.from - previous.from;
                  if (Math.abs(delta) > 500) panOthers(cell.id, delta);
                }
              }
              const tick = Date.now();
              if (tick - lastViewport < 320) return;
              lastViewport = tick;
              viewportRef.current?.({ cellId: cell.id, timeframe: cell.chart?.market?.timeframe ?? "15", from: range.from, to: range.to });
            });
          } catch {
            /* 旧版本没有 onViewportChange 时忽略 */
          }
          // 「时间轴」勾选时：点任意一格（K 线或时间轴附近）→ 其他格居中到同一时刻。
          // 只对齐时间，不动缩放；不勾选时完全不联动。
          const handleClick = (event: { time?: number | null }) => {
            const at = event?.time;
            if (replayArmedRef.current && typeof at === 'number') {
              void startReplay(at, cell.id).catch(error => onError?.(error instanceof Error ? error.message : String(error))); return;
            }
            if (replaying() || !timeSyncRef.current) return;
            if (typeof at !== 'number') return;
            jumpAllTo(at, cell.id);
          };
          try {
            // 公开的渲染器点击接口不会把拖动结束当作点击。
            const renderer = cell.chart?.renderer;
            if (typeof renderer?.onClick === 'function') renderer.onClick(handleClick);
          } catch {
            /* 两个都没有时忽略 */
          }
          // 记下初始范围：第一次拖动就能算出时间增量。
          try {
            const initial = cell.chart?.getVisibleRange?.();
            if (initial) lastRangeRef.current.set(cell.id, { from: initial.from, to: initial.to });
          } catch {
            /* ignore */
          }
          // 选择列表过滤：bigwolf 的 MACD 副图由代码配对，不从清单里让用户单独加。
          try {
            const original = cell.chart?.availableNativeIndicators?.bind(cell.chart);
            if (original && !cell.__tpFiltered) {
              cell.__tpFiltered = true;
              cell.chart.availableNativeIndicators = async () => {
                const rows = await original();
                return rows.filter((row: { type: string }) => row.type !== 'bigwolf-macd');
              };
            }
          } catch {
            /* 没有原生指标 API 时忽略 */
          }
          cell.chart?.on?.('load:end', () => {
            focusOne(cell);
            lockDrawings(cell);
            annotate(cell);
            try {
              const api = cell.chart?.drawings;
              if (favoritesRef.current.length) api?.setFavorites?.(favoritesRef.current);
              onFavorites?.(api?.favorites?.() ?? favoritesRef.current);
            } catch {
              /* 旧版本没有收藏 API 时忽略 */
            }
          });
          cell.chart?.on?.('drawing:favorites', ({ favorites }: { favorites: string[] }) => {
            favoritesRef.current = favorites;
            onFavorites?.(favorites);
          });
          cell.chart?.on?.('drawing:tool', ({ type }: { type: string | null }) => {
            onTool?.(type ?? null);
          });
          cell.chart?.on?.('market:changed', () => {
            onTimeframe?.(cell.chart?.market?.timeframe ?? '15');
            window.setTimeout(() => { if (!replaying()) focusOne(cell); }, 30);
          });
        };

        ws.replay?.on('replay:end', () => {
          if (replayBusyRef.current) return;
          replayArmedRef.current = false;
          queueMicrotask(() => {
            if (disposed || replayBusyRef.current || ws.replay?.state.active) return;
            showReplayMarks(true);
            void flushReplayPending().catch(error => onError?.(String(error)));
          });
        });
        ws.cells().forEach(bind);
        // 轮询到 K 线就绪再标注（每格只标一次），15 秒后放弃。
        const markTimer = window.setInterval(() => {
          if (disposed) {
            window.clearInterval(markTimer);
            return;
          }
          ws.cells().forEach(annotate);
        }, 400);
        window.setTimeout(() => window.clearInterval(markTimer), 15000);
        ws.on?.('cell:created', () => ws.cells().forEach(bind));
        ws.on?.('cell:active', () => {
          onTimeframe?.(ws.active?.chart?.market?.timeframe ?? '15');
        });
        ws.on?.('layout:changed', ({ layout }: { layout: string }) => {
          onLayout?.(layout);
          ws.cells().forEach(bind);
        });
        ws.on?.('state:changed', () => {
          try {
            if (!replaying()) onStateChange?.(stripMarks(ws.getState()));
          } catch {
            /* ignore */
          }
        });

        // 调试钩子：页面里可以直接拿到 workspace 检查各格范围（不影响功能）。
        (window as any).__tpWs = ws;
        setReady(true);
        onLayout?.(ws.getState?.()?.layout ?? '4');
        onTimeframe?.(ws.active?.chart?.market?.timeframe ?? '15');
        onSyncs?.(stateWithTimeSync(ws));
        // 首批 K 线落地前 setVisibleRange 会被边界夹住，这里补一次定位。
        // 再补几拍：静态复盘数据没有 load:end 事件，首帧宽度也可能是 0，
        // 早跳会被夹到最左边，看起来就像"没跳到开仓"。
        focusAll(ws, anchorRef.current, props.tradeMarks);
        for (const delay of [80, 240, 600, 1200]) {
          window.setTimeout(() => {
            if (!disposed && !replaying()) focusAll(ws, anchorRef.current, props.tradeMarks);
          }, delay);
        }
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      disposed = true;
      replayRequestRef.current += 1;
      replayArmedRef.current = false; replayBusyRef.current = false; replayPendingRef.current.clear();
      const ws = wsRef.current;
      wsRef.current = null;
      try {
        ws?.destroy?.();
      } catch {
        /* ignore */
      }
      if (host) host.innerHTML = '';
    };
    // charts 的一次性数据：换交易时整个组件重挂载（key 由上层控制）。
  }, [charts, symbol]);

  // Reuse Vela's actual controls and listeners instead of duplicating its APIs.
  // The workspace keeps owning the menus/dialogs and destroys the toolbar.
  useEffect(() => {
    const target = props.toolbarHost;
    if (!ready || !target) return;
    let disposed = false;
    let toolbar: HTMLElement | null = null;
    let parent: HTMLElement | null = null;
    let next: ChildNode | null = null;
    void Promise.all([import('@luxalgo/vela/ui'), import('@luxalgo/vela')]).then(([ui, vela]) => {
      if (disposed) return;
      toolbar = hostRef.current?.querySelector<HTMLElement>('.vela-widget-topbar') ?? null;
      if (!toolbar) return;
      parent = toolbar.parentElement;
      next = toolbar.nextSibling;
      ui.ensureUIHost(target, vela.resolveTheme(theme));
      target.lang = chartLocale;
      target.appendChild(toolbar);
    }).catch(() => { /* Keep the original toolbar usable if mounting fails. */ });
    return () => {
      disposed = true;
      if (toolbar?.parentElement === target && parent?.isConnected) {
        parent.insertBefore(toolbar, next?.parentNode === parent ? next : null);
      }
    };
  }, [ready, props.toolbarHost, theme, chartLocale]);

  // 外观三项跟着「设置」实时切换：主题、显示时区、图表语言。
  // `ready` 之前 ws 还没建好，等就绪后这套 effect 会再跑一次把初始值补上。
  useEffect(() => {
    try {
      wsRef.current?.setTheme?.(theme);
    } catch {
      /* 旧版本没有 setTheme 时忽略 */
    }
    // 十字线单独调亮：主题自带的太淡，压在 K 线上几乎看不见。
    // applyConfig 挂在渲染器上（chart.rendererControl.renderer），不在 chart 上。
    for (const cell of wsRef.current?.cells?.() ?? []) {
      try {
        cell.chart?.rendererControl?.renderer?.applyConfig?.({
          crosshair: theme === 'light'
            ? { color: '#3f4c5c', width: 1, style: 'dashed', opacity: 0.9 }
            : { color: '#e2e8f0', width: 1, style: 'dashed', opacity: 0.9 },
        });
      } catch {
        /* 渲染器没有 applyConfig 时忽略 */
      }
    }
  }, [theme, ready]);

  useEffect(() => {
    try {
      wsRef.current?.setTimezone?.(resolveZone(timezone));
    } catch {
      /* ignore */
    }
  }, [timezone, ready]);

  useEffect(() => {
    try {
      wsRef.current?.setLocale?.(chartLocale);
    } catch {
      /* ignore */
    }
  }, [chartLocale, ready]);

  // 定位点变化（比如从列表点开另一笔、或时间基对齐后 anchor 被修正）时补一次居中：
  // 图表已经在屏幕上时，初始化那一跳不会重跑，这里兜住。
  useEffect(() => {
    if (!ready || !(anchorMs > 0) || replaying()) return;
    try {
      focusAll(wsRef.current, anchorMs, props.tradeMarks);
    } catch {
      /* ignore */
    }
  }, [anchorMs, ready]);

  // 配对轮询：主图出现就补副图，主图消失就删副图（手动删副图不会被补回）。
  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => {
      for (const cell of wsRef.current?.cells?.() ?? []) {
        try {
          reconcilePairing(cell);
        } catch {
          /* ignore */
        }
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [ready]);

  return (
    <div className="chart-shell">
      <div ref={hostRef} className={`chart-host ${ready ? 'is-ready' : ''}`} />
      {!ready ? <div className="chart-loading">正在加载图表…</div> : null}
    </div>
  );
});

function basePeriodKey(base: BaseTimeframe): string {
  return base === 'M1' ? '1' : base === 'M5' ? '5' : base === 'M15' ? '15' : '60';
}

function toOhlcv(bar: number[]) {
  return { time: bar[0] * 1000, open: bar[1], high: bar[2], low: bar[3], close: bar[4], volume: bar[5] ?? 0 };
}

function focusAll(ws: any, anchorMs: number, marks?: { openedAt: number; closedAt: number } | null): void {
  if (!ws) return;
  ws.cells?.().forEach((cell: any) => {
    const tf = cell?.chart?.market?.timeframe ?? '15';
    const minutes = timeframeMinutes(tf) ?? 15;
    const width = minutes * 60_000;
    try {
      if (marks && marks.openedAt > 0 && marks.closedAt > 0) {
        const start = Math.min(marks.openedAt, marks.closedAt) * 1000;
        const end = Math.max(marks.openedAt, marks.closedAt) * 1000;
        const pad = Math.max(width * 12, (end - start) * 0.25);
        cell.chart.setVisibleRange({ from: start - pad, to: end + pad });
        return;
      }
      if (!Number.isFinite(anchorMs) || anchorMs <= 0) return;
      // 开仓那根 K 线落在正中（左右各 22 根）。
      cell.chart.setVisibleRange({ from: anchorMs - width * 22, to: anchorMs + width * 22 });
    } catch {
      /* ignore */
    }
  });
}

export const TIMEFRAME_OPTIONS = Object.keys(TIMEFRAMES)
  .filter((tf) => TF_LABEL[tf])
  .map((tf) => ({ id: tf, label: TF_LABEL[tf] }));
