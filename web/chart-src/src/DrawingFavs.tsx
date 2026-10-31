import { toolIcon, toolLabel } from './vela/drawingTools';

/**
 * 顶部画图收藏栏：只镜像 Vela 左侧工具栏里「添加到收藏」选的工具。
 * 收藏本身在左侧工具栏里操作，这里只负责快速切换。
 */
export interface DrawingFavsProps {
  favorites: string[];
  active: string | null;
  onUse: (key: string) => void;
}

export function DrawingFavs({ favorites, active, onUse }: DrawingFavsProps) {
  return (
    <div className="fav-tools">
      {favorites.length ? (
        favorites.map((key) => (
          <button
            key={key}
            type="button"
            className={`tool-btn icon ${active === key ? 'is-active' : ''}`}
            title={toolLabel(key)}
            onClick={() => onUse(key)}
          >
            {toolIcon(key)}
          </button>
        ))
      ) : (
        <span className="fav-hint">左侧工具栏 →「添加到收藏」</span>
      )}
    </div>
  );
}
