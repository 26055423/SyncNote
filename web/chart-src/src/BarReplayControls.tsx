import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ChartHandle, ReplayUiState } from './vela/ChartWorkspace';
import { stamp } from './api';

const iconProps = {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
} as const;

/** 随机：骰子。 */
const DiceIcon = () => (
  <svg {...iconProps}>
    <rect x="4.5" y="4.5" width="15" height="15" rx="3" />
    <circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);
/** 点选：十字光标。 */
const CrosshairIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="6.5" />
    <path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5" />
  </svg>
);
/** 当前视图：方框加眼睛点。 */
const ViewIcon = () => (
  <svg {...iconProps}>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
    <circle cx="12" cy="12" r="2.4" />
  </svg>
);
/** 最早：双箭头到左端。 */
const EarliestIcon = () => (
  <svg {...iconProps}>
    <path d="M6 5v14" />
    <path d="M11 12l6-6M11 12l6 6" />
  </svg>
);
const PlayIcon = () => (
  <svg {...iconProps}><path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none" /></svg>
);
const PauseIcon = () => (
  <svg {...iconProps}><path d="M9 5v14M15 5v14" /></svg>
);
const StepIcon = () => (
  <svg {...iconProps}>
    <path d="M6 5.5v13l8-6.5z" fill="currentColor" stroke="none" />
    <path d="M17 5v14" />
  </svg>
);
const CloseIcon = () => (
  <svg {...iconProps}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
const CaretIcon = () => (
  <svg {...iconProps}><path d="M6 9.5l6 6 6-6" /></svg>
);

const idle: ReplayUiState = { available: false, active: false, playing: false, armed: false, busy: false, cursorTime: null, clockTime: null, remaining: 0, intervalMs: 1000 };

/** 起点模式：左边大按钮按当前模式执行一次，右边三角只用来切换模式。 */
type StartMode = 'random' | 'click' | 'view' | 'earliest';
const MODES: Array<{ key: StartMode; label: string; hint: string; Icon: () => React.ReactElement }> = [
  { key: 'random', label: '随机K线', hint: '随机挑一段有数据的历史开始回放', Icon: DiceIcon },
  { key: 'click', label: '点选K线', hint: '在图上点一根 K 线作为起点', Icon: CrosshairIcon },
  { key: 'view', label: '当前视图', hint: '用当前视口里最早的一根当起点', Icon: ViewIcon },
  { key: 'earliest', label: '最早日期', hint: '从当前数据最早一根开始', Icon: EarliestIcon },
];

/**
 * 回放控制条：顶部工具栏内联，紧跟「行情 | 回放」。
 * 左边是「模式 + 执行」按钮，右边小三角切模式；随后是播放/逐根/速度/时钟/退出。
 */
export function BarReplayControls({ chart, onActiveChange, onEarliest, onRandom, onArmedChange }: {
  chart: RefObject<ChartHandle | null>;
  onActiveChange: (active: boolean) => void;
  /** 跳到「最早可用日期」再开始回放；由上层按当前数据算最早一根。 */
  onEarliest?: () => Promise<void>;
  /** 随机挑一个「数据库里确实有数据」的时点开始回放。 */
  onRandom?: () => Promise<void>;
  /** 是否处于「选起点」状态：上层据此画右侧半透明遮罩。 */
  onArmedChange?: (armed: boolean) => void;
}) {
  const [state, setState] = useState(idle);
  const [speed, setSpeed] = useState(1000);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<StartMode>(() => {
    try {
      const saved = localStorage.getItem('sn-replay-mode');
      if (saved === 'random' || saved === 'click' || saved === 'view' || saved === 'earliest') return saved;
    } catch { /* ignore */ }
    return 'random';
  });
  const busyRef = useRef(false);

  useEffect(() => {
    const read = () => {
      const next = chart.current?.replayStatus() ?? idle;
      setState(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      onActiveChange(next.active || next.armed || next.busy);
      onArmedChange?.(Boolean(next.armed));
    };
    read(); const timer = window.setInterval(read, 200);
    return () => window.clearInterval(timer);
  }, [chart, onActiveChange, onArmedChange]);

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
  if (!entered) return null;

  const current = MODES.find((item) => item.key === mode) ?? MODES[0];
  const CurrentIcon = current.Icon;

  /** 大按钮：按当前模式执行一次（随机/最早/当前视图直接开始，点选进入选点状态）。 */
  const run = () => {
    if (busyRef.current) return;
    setError('');
    if (mode === 'click') { chart.current?.replaySelect(); return; }
    if (mode === 'view') {
      busyRef.current = true;
      void chart.current?.replayStartFromView()
        .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
        .finally(() => { busyRef.current = false; });
      return;
    }
    const action = mode === 'random' ? onRandom : onEarliest;
    if (!action) { setError('这个起点方式暂不可用'); return; }
    busyRef.current = true;
    void action()
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => { busyRef.current = false; });
  };

  return (
    <div className="replay-bar" role="toolbar" aria-label="K线回放">
      <div className="replay-pick">
        <button type="button" className="tool-btn replay-run" title={current.hint} onClick={run}>
          <CurrentIcon /> {current.label}
        </button>
        <button
          type="button"
          className="tool-btn replay-mode-toggle"
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label="切换起点方式"
          title="切换起点方式"
          onClick={() => setMenu(open => !open)}
        >
          <CaretIcon />
        </button>
        {menu ? (
          <div className="replay-pick-menu" role="menu" aria-label="起点方式">
            {MODES.map((item) => {
              const ModeIcon = item.Icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.key === mode}
                  className={item.key === mode ? 'is-active' : ''}
                  onClick={() => {
                    setMode(item.key);
                    setMenu(false);
                    try { localStorage.setItem('sn-replay-mode', item.key); } catch { /* ignore */ }
                  }}
                >
                  <ModeIcon /> {item.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        className="tool-btn"
        aria-label={state.playing ? '暂停回放' : '播放回放'}
        disabled={choosing}
        onClick={() => (state.playing ? chart.current?.replayPause() : chart.current?.replayPlay(speed))}
      >
        {state.playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <button type="button" className="tool-btn" title="按各窗格中下一根最早收盘的 K 线推进" disabled={choosing} onClick={() => chart.current?.replayStep()}>
        <StepIcon />
      </button>
      <label>
        速度
        <select
          aria-label="回放速度"
          value={speed}
          disabled={choosing}
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
        {choosing
          ? (state.busy ? '正在准备回放…' : '点图表选起点')
          : `${state.clockTime ? stamp(state.clockTime / 1000).slice(5, 16) : '准备中'} · 余 ${state.remaining}`}
      </span>

      <button type="button" className="tool-btn" onClick={() => { chart.current?.replayStop(); setError(''); setMenu(false); }}>
        <CloseIcon /> 退出
      </button>
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}
