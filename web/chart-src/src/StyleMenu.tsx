import { useEffect, useRef, useState } from 'react';

/** 图表样式（K线/美国线/折线/面积图/基准线/平均K线）。自己实现，行为与「周期」下拉一致：
 *  点一下展开、点外部或 Esc 关闭，不做悬停展开（Vela 自带那个会一移动就收）。 */
export type PriceStyle = 'candles' | 'bars' | 'line' | 'area' | 'baseline' | 'heikinashi';

const STYLES: Array<{ id: PriceStyle; label: string }> = [
  { id: 'candles', label: 'K线' },
  { id: 'bars', label: '美国线' },
  { id: 'line', label: '折线' },
  { id: 'area', label: '面积图' },
  { id: 'baseline', label: '基准线' },
  { id: 'heikinashi', label: '平均K线' },
];

function StyleIcon({ id }: { id: PriceStyle }) {
  const common = {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
  };
  if (id === 'candles') return (
    <svg {...common}><path d="M8 4v3M8 17v3M16 5v2M16 17v2" /><rect x="5.8" y="7" width="4.4" height="10" rx="1" /><rect x="13.8" y="7" width="4.4" height="10" rx="1" /></svg>
  );
  if (id === 'bars') return (
    <svg {...common}><path d="M8 5v14M8 9h4M8 15h-4M16 5v14M16 9h4M16 15h-4" /></svg>
  );
  if (id === 'line') return (
    <svg {...common}><path d="M3 16l5-5 4 3 4-6 5 4" /></svg>
  );
  if (id === 'area') return (
    <svg {...common}><path d="M3 16l5-5 4 3 4-6 5 4v5H3z" fill="currentColor" fillOpacity=".18" /></svg>
  );
  if (id === 'baseline') return (
    <svg {...common}><path d="M3 12h18" /><path d="M3 18l5-4 4 2 4-5 5 3" /></svg>
  );
  return (
    <svg {...common}><path d="M7 4v3M7 17v3M17 4v3M17 17v3" /><rect x="4.8" y="7" width="4.4" height="10" rx="1" /><rect x="14.8" y="7" width="4.4" height="10" rx="1" /></svg>
  );
}

export function StyleMenu({ current, onPick }: { current: PriceStyle; onPick: (id: PriceStyle) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const currentLabel = STYLES.find((s) => s.id === current)?.label ?? 'K线';

  return (
    <div className="style-menu" ref={rootRef}>
      <button
        type="button"
        className="tool-btn style-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`图表样式：${currentLabel}`}
        title={`图表样式：${currentLabel}`}
        onClick={() => setOpen((value) => !value)}
      >
        <StyleIcon id={current} />
        <span className="style-menu-caret" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="style-menu-list" role="menu" aria-label="图表样式">
          {STYLES.map((style) => (
            <button
              key={style.id}
              type="button"
              role="menuitemradio"
              aria-checked={style.id === current}
              className={`style-menu-item ${style.id === current ? 'is-active' : ''}`.trim()}
              onClick={() => { onPick(style.id); setOpen(false); }}
            >
              <StyleIcon id={style.id} />
              <span>{style.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
