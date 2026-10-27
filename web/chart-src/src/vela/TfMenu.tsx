import { useEffect, useRef, useState } from 'react';

/**
 * 周期菜单（当前格子）。
 *
 * 不用 Vela 自带的周期下拉：它渲染在工作区内部，指针从触发器移向列表时会被画布
 * 抢走命中区而收起。这里只提供后端真正有 K 线的周期。
 */

export function TfMenu({ current, options, onPick }: { current: string; options: Array<{ id: string; label: string }>; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

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

  const label = options.find((option) => option.id === current)?.label ?? current;

  return (
    <div className="tp-menu" ref={rootRef}>
      <button type="button" className={`tp-btn ${open ? 'is-active' : ''}`} onClick={() => setOpen((value) => !value)} title="当前格子的周期">
        {label}
        <span className="tp-caret" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="tp-panel" role="listbox" aria-label="周期">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={option.id === current}
              className={`tp-item ${option.id === current ? 'is-current' : ''}`}
              onClick={() => {
                onPick(option.id);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
