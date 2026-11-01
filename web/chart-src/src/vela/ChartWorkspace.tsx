import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { aggregate, ReviewProvider, TIMEFRAMES, TF_LABEL, timeframeMinutes, type BaseTimeframe, type ReviewCharts } from './provider';
import { prefs, usePrefs } from '../ui/prefs';
import { resolveZone } from '../lib/time';

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
function markColors(theme: string): { line: string; buy: string; sell: string } {
  return theme === 'light'
    ? { line: '#b8862b', buy: '#1f6fd0', sell: '#c0392b' }
    : { line: '#e2bd77', buy: '#86c7ed', sell: '#e08a8a' };
}

/**
 * 存档里的 `rendererConfig` 记的是**生成存档时那台机器**的主题配色
 * （背景、网格、边框、文字、涨跌色）。回放它会让「面板已换成浅色、K 线还是黑的」，
 * 所以套用前先剥掉：配色只认本站「设置 → 主题」。
 */
function stripTheme(document: unknown): unknown {
  if (!document || typeof document !== 'object') return document;
  let copy: any;
  try {
    copy = JSON.parse(JSON.stringify(document));
  } catch {
    return document;
  }
  if (Array.isArray(copy.charts)) {
    for (const chart of copy.charts) {
      if (chart && typeof chart === 'object') delete chart.rendererConfig;
    }
  }
  return copy;
}

export interface ChartHandle {
  setLayout(id: string): void;
  getLayout(): string;
  setTimeframe(tf: string): void;
  getTimeframe(): string;
  focus(timestampMs?: number): void;
  toggleSync(kind: SyncKind): void;
  getSyncs(): Partial<Record<SyncKind, boolean>>;
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
  applySeries(base: BaseTimeframe, bars: number[][]): void;
}

export type SyncKind = 'symbol' | 'timeframe' | 'crosshair' | 'viewport' | 'drawings' | 'style';

interface Props {
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
  onViewport?: (info: { timeframe: string; from: number; to: number }) => void;
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
  const anchorRef = useRef(anchorMs);
  const favoritesRef = useRef<string[]>(props.favorites ?? []);
  const markIdsRef = useRef<Set<string>>(new Set());
  const markIdsByCellRef = useRef<Map<string, Set<string>>>(new Map());
  // 分享时要把开平仓标注剔掉，`stripMarks` 定义在初始化闭包里，用 ref 传出来。
  const stripRef = useRef<((document: unknown) => unknown) | null>(null);
  const [ready, setReady] = useState(false);
  const { theme, timezone, chartLocale } = usePrefs();
  // 标注是在事件回调里画的，回调闭包拿不到最新的 props，用 ref 兜住当前主题。
  const themeRef = useRef(theme);
  themeRef.current = theme;

  anchorRef.current = anchorMs;

  useImperativeHandle(ref, () => ({
    setLayout(id) {
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
      wsRef.current?.cells?.().forEach((cell: any) => {
        void cell.chart?.setMarket?.({ timeframe: tf });
      });
      onTimeframe?.(tf);
    },
    getTimeframe() {
      return wsRef.current?.active?.chart?.market?.timeframe ?? '15';
    },
    focus(timestampMs) {
      focusAll(wsRef.current, timestampMs ?? anchorRef.current);
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
    applySeries(base, bars) {
      dataRef.current = { ...dataRef.current, [base]: bars };
      for (const cell of wsRef.current?.cells?.() ?? []) {
        const tfId: string = cell.chart?.market?.timeframe ?? '15';
        const recipe = TIMEFRAMES[tfId];
        if (!recipe || recipe.base !== base) continue;
        const source = dataRef.current[recipe.base] ?? [];
        if (!source.length) continue;
        const baseSeconds = TIMEFRAMES[basePeriodKey(recipe.base)]?.seconds ?? 60;
        const rendered = recipe.seconds === baseSeconds ? source : aggregate(source, recipe.seconds);
        try {
          cell.chart.setBars(rendered.map(toOhlcv), { preserveView: true });
        } catch {
          /* 渲染器不支持 setBars 时忽略：下次重挂载会拿到新数据 */
        }
      }
    },
    toggleSync(kind) {
      const ws = wsRef.current;
      if (!ws) return;
      const state = ws.sync?.state?.() ?? {};
      ws.sync?.set?.(kind, !state[kind]);
    },
    getSyncs() {
      return (wsRef.current?.sync?.state?.() ?? {}) as Partial<Record<SyncKind, boolean>>;
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

        const provider = (props.provider as never) ?? new ReviewProvider(charts, symbol, props.providerName || 'review');
        const providerName = props.provider ? (props.providerName || 'live') : (props.providerName || 'review');
        const initial = prefs.getState();
        const ws = new VelaWorkspace(hostRef.current, {
          layout: '4',
          symbol: `${providerName}:${symbol}`,
          timeframe: '15',
          cells: seedCells(timeframes),
          live: Boolean(props.provider),
          theme: initial.theme,
          locale: initial.chartLocale,
          // 表格和 K 线时间轴必须用同一个显示时区，否则「复盘跳到这根 K 线」会对不上。
          timezone: resolveZone(initial.timezone),
          providers: { [providerName]: () => provider },
          sync: { crosshair: true },
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
            ws.applyState(stripTheme(savedState));
          } catch {
            /* 存档不兼容时退回默认布局，不阻塞看图 */
          }
        }
        // 回放后再对齐一次当前主题（布局/存档都可能重建过格子）。
        try {
          ws.setTheme?.(prefs.getState().theme);
        } catch {
          /* ignore */
        }

        const focusOne = (cell: any) => {
          const tf = cell?.chart?.market?.timeframe ?? '15';
          const minutes = timeframeMinutes(tf) ?? 15;
          const width = minutes * 60_000;
          const anchor = anchorRef.current;
          if (!Number.isFinite(anchor) || anchor <= 0) return;
          try {
            // 开仓那根 K 线落在正中（左右各 22 根），点开复盘第一眼就对着开仓。
          cell.chart.setVisibleRange({ from: anchor - width * 22, to: anchor + width * 22 });
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
          const color = marks.side === 'sell' ? palette.sell : palette.buy;
          try {
            const line = api.add('trendline', {
              anchors: [{ time: opened, price: marks.open }, { time: closed, price: marks.close }],
              style: { lineColor: palette.line, lineWidth: 1, lineStyle: 'dashed' },
            });
            const entry = api.add('text', {
              anchors: [{ time: opened, price: marks.open }],
              text: { value: '开仓 ' + marks.open.toFixed(2), size: 'small', hAlign: 'center', vAlign: 'bottom', color },
            });
            const exit = api.add('text', {
              anchors: [{ time: closed, price: marks.close }],
              text: { value: '平仓 ' + marks.close.toFixed(2), size: 'small', hAlign: 'center', vAlign: 'top', color },
            });
            const ids = new Set<string>();
            for (const drawing of [line, entry, exit]) {
              const id = (drawing as { id?: string } | null)?.id;
              if (id) {
                ids.add(id);
                markIdsRef.current.add(id);
              }
            }
            if (ids.size) markIdsByCellRef.current.set(cell.id, ids);
          } catch (error) {
            console.warn('trade marks failed', error);
          }
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
          // 拖动/缩放时把可见范围报上去，由上层决定补哪段、删哪段。
          let lastViewport = 0;
          try {
            cell.chart?.onViewportChange?.((range: { from: number; to: number }) => {
              const tick = Date.now();
              if (tick - lastViewport < 320) return;
              lastViewport = tick;
              viewportRef.current?.({ timeframe: cell.chart?.market?.timeframe ?? "15", from: range.from, to: range.to });
            });
          } catch {
            /* 旧版本没有 onViewportChange 时忽略 */
          }
          if (!cell || cell.__tpBound) return;
          cell.__tpBound = true;
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
            window.setTimeout(() => focusOne(cell), 30);
          });
        };

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
            onStateChange?.(stripMarks(ws.getState()));
          } catch {
            /* ignore */
          }
        });

        setReady(true);
        onLayout?.(ws.getState?.()?.layout ?? '4');
        onTimeframe?.(ws.active?.chart?.market?.timeframe ?? '15');
        onSyncs?.((ws.sync?.state?.() ?? {}) as Partial<Record<SyncKind, boolean>>);
        // 首批 K 线落地前 setVisibleRange 会被边界夹住，这里补一次定位。
        focusAll(ws, anchorRef.current);
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      disposed = true;
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

  // 外观三项跟着「设置」实时切换：主题、显示时区、图表语言。
  // `ready` 之前 ws 还没建好，等就绪后这套 effect 会再跑一次把初始值补上。
  useEffect(() => {
    try {
      wsRef.current?.setTheme?.(theme);
    } catch {
      /* 旧版本没有 setTheme 时忽略 */
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

function focusAll(ws: any, anchorMs: number): void {
  if (!ws || !Number.isFinite(anchorMs) || anchorMs <= 0) return;
  ws.cells?.().forEach((cell: any) => {
    const tf = cell?.chart?.market?.timeframe ?? '15';
    const minutes = timeframeMinutes(tf) ?? 15;
    const width = minutes * 60_000;
    try {
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
