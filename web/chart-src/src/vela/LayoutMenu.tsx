import { useEffect, useRef, useState } from 'react';
import { ToolbarIcon } from '../ui/ToolbarIcon';
import { CUSTOM_LAYOUTS, LAYOUT_GROUPS, gridId, slotRects, type LayoutDef } from './layoutDefs';

/**
 * TradingView-style layout picker: mini diagrams instead of text rows.
 *
 * Vela's built-in picker draws only rectangles, so asymmetric presets degrade to text
 * there. This menu renders every preset as an SVG thumbnail (weights and `areas` are
 * projected into the same geometry the workspace uses) and calls `setLayout(id)` —
 * which accepts both registered ids and the synthesized `g<rows>x<cols>` grids.
 */

const BY_ID = new Map(CUSTOM_LAYOUTS.map((def) => [def.id, def]));

function Thumb({ rects, active, size = 54 }: { rects: ReturnType<typeof slotRects>; active: boolean; size?: number }) {
  const h = Math.round(size * 0.66);
  return (
    <svg width={size} height={h} viewBox={`0 0 ${size} ${h}`} aria-hidden="true" className={`lp-thumb ${active ? 'is-active' : ''}`}>
      {rects.map((r, i) => (
        <rect
          key={i}
          x={r.x * size + 1.5}
          y={r.y * h + 1.5}
          width={Math.max(2, r.w * size - 3)}
          height={Math.max(2, r.h * h - 3)}
          rx={1}
          className="lp-rect"
        />
      ))}
    </svg>
  );
}

function gridDef(rows: number, cols: number): Pick<LayoutDef, 'cols' | 'rows'> {
  return { cols: Array.from({ length: cols }, () => 1), rows: Array.from({ length: rows }, () => 1) };
}

export type SyncKindId = 'symbol' | 'timeframe' | 'crosshair' | 'viewport' | 'dateRange' | 'drawings' | 'style';

/** TradingView's "sync to all charts" list, in their order. 只保留本站真的能改的项。 */
const SYNC_ROWS: { kind: SyncKindId; label: string; title?: string }[] = [
  { kind: 'timeframe', label: '周期' },
  { kind: 'crosshair', label: '十字线' },
  { kind: 'viewport', label: '时间定位', title: '点击或拖动时对齐时间，保持各窗口的 K 线宽度；日期范围关闭时生效。' },
  { kind: 'dateRange', label: '日期范围', title: '同步拖动与缩放，所有窗口显示同一段日期。高周期可能只显示少量 K 线；默认关闭。' },
  { kind: 'drawings', label: '绘图同步到所有图表' },
];

export function LayoutMenu({
  current,
  onPick,
  syncs,
  onToggleSync,
  compact = false,
  disabled = false,
}: {
  current: string;
  onPick: (id: string) => void;
  syncs: Partial<Record<SyncKindId, boolean>>;
  onToggleSync: (kind: SyncKindId) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const currentDef = BY_ID.get(current);
  const grid = /^g(\d+)x(\d+)$/.exec(current);
  const nativeGrid: Record<string, [number, number]> = { '1': [1, 1], '2h': [1, 2], '2v': [2, 1], '4': [2, 2] };
  const native = nativeGrid[current];
  const selectedGrid = native ? gridId(native[0], native[1]) : current;
  const triggerRects = currentDef
    ? slotRects(currentDef)
    : grid
      ? slotRects(gridDef(Number(grid[1]), Number(grid[2])))
      : slotRects(gridDef(...(native ?? [2, 2])));

  return (
    <div className={`lp${compact ? ' is-compact' : ''}`} ref={rootRef}>
      <button disabled={disabled} type="button" className={`vela-tool-btn lp-trigger ${open ? 'is-active' : ''}`} onClick={() => setOpen((v) => !v)} title="图表布局与同步" aria-label="图表布局与同步" aria-haspopup="dialog" aria-expanded={open}>
        {compact ? <ToolbarIcon name="layout" /> : <Thumb rects={triggerRects} active={false} size={24} />}
        {compact ? null : <span className="lp-trigger-label">布局</span>}
      </button>

      {open ? (
        <div className="lp-panel" role="dialog" aria-label="图表布局与同步">
          <div className="lp-section">
            <span className="lp-section-title">{'均匀网格'}</span>
            <div className="lp-canvas" onMouseLeave={() => setHover(null)}>
              {Array.from({ length: 16 }, (_, i) => {
                const r = Math.floor(i / 4);
                const c = i % 4;
                const lit = hover ? r <= hover.r && c <= hover.c : false;
                const isCurrent = selectedGrid === gridId(r + 1, c + 1);
                return (
                  <button
                    key={i}
                    type="button"
                    className={`lp-cell ${lit ? 'is-lit' : ''} ${isCurrent ? 'is-current' : ''}`}
                    onMouseEnter={() => setHover({ r, c })}
                    onClick={() => {
                      onPick(gridId(r + 1, c + 1));
                      setOpen(false);
                    }}
                    aria-label={`${r + 1} 行 × ${c + 1} 列`}
                    title={`${r + 1} 行 × ${c + 1} 列`}
                  />
                );
              })}
            </div>
            <span className="lp-hint">{hover ? `${hover.r + 1} × ${hover.c + 1} · ${(hover.r + 1) * (hover.c + 1)}` : '悬停预览，点击应用'}</span>
          </div>

          {LAYOUT_GROUPS.map((group) => (
            <div className="lp-section" key={group.title}>
              <span className="lp-section-title">{group.title}</span>
              <div className="lp-row">
                {group.ids.map((id) => {
                  const def = BY_ID.get(id);
                  if (!def) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`lp-item ${current === id ? 'is-current' : ''}`}
                      onClick={() => {
                        onPick(id);
                        setOpen(false);
                      }}
                      title={def.label}
                      aria-label={def.label}
                    >
                      <Thumb rects={slotRects(def)} active={current === id} />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="lp-section lp-sync">
            <span className="lp-section-title">{'同步到所有图表'}</span>
            {SYNC_ROWS.map((row) => {
              const on = Boolean(syncs[row.kind]);
              return (
                <label key={row.kind} className="lp-sync-row" title={row.title}>
                  <span>{row.label}</span>
                  <input
                    type="checkbox"
                    className="lp-switch"
                    checked={on}
                    onChange={() => onToggleSync(row.kind)}
                    aria-label={row.label}
                    title={row.title}
                  />
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
