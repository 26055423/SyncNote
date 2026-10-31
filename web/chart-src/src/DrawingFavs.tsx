import { useEffect, useRef, useState } from 'react';
import { DRAWING_TOOLS, toolIcon, toolLabel } from './vela/drawingTools';

/**
 * 顶部画图工具收藏栏：只显示常用的几个，点一下就进入画线模式；
 * 右侧「＋」里勾选要收藏的工具，存在浏览器本地。
 */
export interface DrawingFavsProps {
  favorites: string[];
  active: string | null;
  onChange: (favorites: string[]) => void;
  onUse: (key: string) => void;
}

export function DrawingFavs({ favorites, active, onChange, onUse }: DrawingFavsProps) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const toggle = (key: string) => {
    onChange(favorites.includes(key) ? favorites.filter((item) => item !== key) : [...favorites, key]);
  };

  const groups = [...new Set(DRAWING_TOOLS.map((tool) => tool.group))];

  return (
    <div className="fav-tools" ref={boxRef}>
      {favorites.map((key) => (
        <button
          key={key}
          type="button"
          className={`tool-btn icon ${active === key ? 'is-active' : ''}`}
          title={toolLabel(key)}
          onClick={() => onUse(key)}
        >
          {toolIcon(key)}
        </button>
      ))}
      <button type="button" className={`tool-btn icon ${open ? 'is-active' : ''}`} title="收藏画图工具" onClick={() => setOpen((v) => !v)}>
        ＋
      </button>
      {open ? (
        <div className="fav-pop">
          <header>
            <strong>收藏画图工具</strong>
            <span className="dim">勾选后会出现在上方</span>
          </header>
          <div className="fav-list">
            {groups.map((group) => (
              <section key={group}>
                <h4>{group}</h4>
                <div className="fav-grid">
                  {DRAWING_TOOLS.filter((tool) => tool.group === group).map((tool) => (
                    <label key={tool.key} className={favorites.includes(tool.key) ? 'is-on' : ''}>
                      <input type="checkbox" checked={favorites.includes(tool.key)} onChange={() => toggle(tool.key)} />
                      <span className="fav-icon">{tool.icon}</span>
                      {tool.label}
                    </label>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
