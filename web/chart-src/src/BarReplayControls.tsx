import { useEffect, useState, type RefObject } from 'react';
import type { ChartHandle, ReplayUiState } from './vela/ChartWorkspace';
import { stamp } from './api';

const idle: ReplayUiState = { available: false, active: false, playing: false, armed: false, busy: false, cursorTime: null, clockTime: null, remaining: 0, intervalMs: 1000 };

/**
 * 回放控制条：浮在图表底部，功能对齐 TradingView 的回放栏。
 * 入口是顶部「行情 | 回放」分段控件；这里只负责选起点和控制播放。
 */
export function BarReplayControls({ chart, onActiveChange, onEarliest }: {
  chart: RefObject<ChartHandle | null>;
  onActiveChange: (active: boolean) => void;
  /** 跳到「最早可用日期」再开始回放；由上层按当前数据算最早一根。 */
  onEarliest?: () => Promise<void>;
}) {
  const [state, setState] = useState(idle);
  const [speed, setSpeed] = useState(1000);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const read = () => {
      const next = chart.current?.replayStatus() ?? idle;
      setState(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      onActiveChange(next.active || next.armed || next.busy);
    };
    read(); const timer = window.setInterval(read, 200);
    return () => window.clearInterval(timer);
  }, [chart, onActiveChange]);

  // 点外部关闭「选择起点」下拉
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.replay-pick')) return;
      setMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const choosing = state.armed || state.busy;
  const entered = state.active || choosing;
  // 未进入回放时什么都不渲染（入口在顶部「行情 | 回放」分段控件里）。
  if (!entered) return null;

  const startFromView = () => {
    setError('');
    void chart.current?.replayStartFromView().catch(error => setError(error instanceof Error ? error.message : String(error)));
  };

  return (
    <div className="replay-bar" role="toolbar" aria-label="K线回放">
      <div className="replay-pick">
        <button type="button" className="tool-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(open => !open)}>
          选择K线 ▾
        </button>
        {menu ? (
          <div className="replay-pick-menu" role="menu" aria-label="选择回放起点">
            <button type="button" role="menuitem" onClick={() => { setMenu(false); setError(''); chart.current?.replaySelect(); }}>
              在图上点选 K 线
            </button>
            <button type="button" role="menuitem" onClick={() => { setMenu(false); startFromView(); }}>
              从当前视图开始
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!onEarliest}
              onClick={() => { setMenu(false); setError(''); void onEarliest?.().catch(error => setError(error instanceof Error ? error.message : String(error))); }}
            >
              最早可用日期
            </button>
          </div>
        ) : null}
      </div>

      {choosing ? (
        <span role="status">{state.busy ? '正在准备回放…' : '点击图表中的 K 线选择起点'}</span>
      ) : (
        <>
          <button
            type="button"
            className="tool-btn"
            aria-label={state.playing ? '暂停回放' : '播放回放'}
            onClick={() => (state.playing ? chart.current?.replayPause() : chart.current?.replayPlay(speed))}
          >
            {state.playing ? 'Ⅱ' : '▶'}
          </button>
          <button type="button" className="tool-btn" title="按各窗格中下一根最早收盘的 K 线推进" onClick={() => chart.current?.replayStep()}>
            ⏭
          </button>
          <label>
            速度
            <select
              aria-label="回放速度"
              value={speed}
              onChange={event => {
                const value = Number(event.target.value);
                setSpeed(value);
                if (state.playing) chart.current?.replayPlay(value);
              }}
            >
              <option value={2000}>0.5×</option>
              <option value={1000}>1×</option>
              <option value={500}>2×</option>
              <option value={200}>5×</option>
            </select>
          </label>
          <span className="replay-clock" role="status" title="所有窗格均只显示此时刻已经收盘的K线">
            {state.clockTime ? stamp(state.clockTime / 1000).slice(5, 16) : '准备中'} · 余 {state.remaining}
          </span>
        </>
      )}

      <button type="button" className="tool-btn" onClick={() => { chart.current?.replayStop(); setError(''); setMenu(false); }}>
        退出
      </button>
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}
