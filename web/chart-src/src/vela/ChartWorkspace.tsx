import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ReviewProvider, TIMEFRAMES, TF_LABEL, timeframeMinutes, type ReviewCharts } from './provider';

/**
 * Vela 工作区（多窗格 K 线）在同频里的封装。
 *
 * - 数据：ReviewProvider（这笔交易已同步的四组 K 线）
 * - 画线：Vela 自带用户绘图，`getState()` 的状态文档就是存档格式
 * - 定位：`?t=<UTC 秒>` → 每个格子把视窗挪到那根 K 线附近
 * - 只读：作业（别人发来的复盘）隐藏绘图工具栏并锁住所有画线
 */

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
}

export type SyncKind = 'symbol' | 'timeframe' | 'crosshair' | 'viewport' | 'drawings' | 'style';

interface Props {
  charts: ReviewCharts;
  symbol: string;
  anchorMs: number;
  savedState: unknown;
  readOnly: boolean;
  timeframes?: string[];
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
  const { charts, symbol, anchorMs, savedState, readOnly, timeframes, onStateChange, onTimeframe, onLayout, onSyncs, onError } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<any>(null);
  const anchorRef = useRef(anchorMs);
  const markIdsRef = useRef<Set<string>>(new Set());
  const markIdsByCellRef = useRef<Map<string, Set<string>>>(new Map());
  const [ready, setReady] = useState(false);

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

        const provider = (props.provider as never) ?? new ReviewProvider(charts, symbol);
        const providerName = props.provider ? (props.providerName || 'live') : 'review';
        const ws = new VelaWorkspace(hostRef.current, {
          layout: '4',
          symbol: `${providerName}:${symbol}`,
          timeframe: '15',
          cells: seedCells(timeframes),
          live: Boolean(props.provider),
          theme: 'dark',
          locale: 'zh-Hans',
          timezone: 'Asia/Shanghai',
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
            ws.applyState(savedState);
          } catch {
            /* 存档不兼容时退回默认布局，不阻塞看图 */
          }
        }

        const focusOne = (cell: any) => {
          const tf = cell?.chart?.market?.timeframe ?? '15';
          const minutes = timeframeMinutes(tf) ?? 15;
          const width = minutes * 60_000;
          const anchor = anchorRef.current;
          if (!Number.isFinite(anchor) || anchor <= 0) return;
          try {
            cell.chart.setVisibleRange({ from: anchor - width * 32, to: anchor + width * 12 });
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
          const opened = marks.openedAt * 1000;
          const closed = marks.closedAt * 1000;
          const color = marks.side === 'sell' ? '#e08a8a' : '#86c7ed';
          try {
            const line = api.add('trendline', {
              anchors: [{ time: opened, price: marks.open }, { time: closed, price: marks.close }],
              style: { lineColor: '#e2bd77', lineWidth: 1, lineStyle: 'dashed' },
            });
            const entry = api.add('text', {
              anchors: [{ time: opened, price: marks.open }],
              text: { value: '开仓 ' + marks.open.toFixed(2), size: 'small', hAlign: 'left', vAlign: 'bottom', color },
            });
            const exit = api.add('text', {
              anchors: [{ time: closed, price: marks.close }],
              text: { value: '平仓 ' + marks.close.toFixed(2), size: 'small', hAlign: 'left', vAlign: 'top', color },
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
          }
          return document;
        };

        const bind = (cell: any) => {
          if (!cell || cell.__tpBound) return;
          cell.__tpBound = true;
          cell.chart?.on?.('load:end', () => {
            focusOne(cell);
            lockDrawings(cell);
            annotate(cell);
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
        // 轮询到 K 线就绪再标注（每格只标一次），15 秒后放弃。
        const markTimer = window.setInterval(() => {
          if (disposed) {
            window.clearInterval(markTimer);
            return;
          }
          ws.cells().forEach(annotate);
        }, 400);
        window.setTimeout(() => window.clearInterval(markTimer), 15000);
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

  return (
    <div className="chart-shell">
      <div ref={hostRef} className={`chart-host ${ready ? 'is-ready' : ''}`} />
      {!ready ? <div className="chart-loading">正在加载图表…</div> : null}
    </div>
  );
});

function focusAll(ws: any, anchorMs: number): void {
  if (!ws || !Number.isFinite(anchorMs) || anchorMs <= 0) return;
  ws.cells?.().forEach((cell: any) => {
    const tf = cell?.chart?.market?.timeframe ?? '15';
    const minutes = timeframeMinutes(tf) ?? 15;
    const width = minutes * 60_000;
    try {
      cell.chart.setVisibleRange({ from: anchorMs - width * 32, to: anchorMs + width * 12 });
    } catch {
      /* ignore */
    }
  });
}

export const TIMEFRAME_OPTIONS = Object.keys(TIMEFRAMES)
  .filter((tf) => TF_LABEL[tf])
  .map((tf) => ({ id: tf, label: TF_LABEL[tf] }));
