import { useEffect, useState, type RefObject } from 'react';
import type { ChartHandle, ReplayUiState } from './vela/ChartWorkspace';
import { stamp } from './api';

const idle: ReplayUiState = { available: false, active: false, playing: false, armed: false, busy: false, cursorTime: null, clockTime: null, remaining: 0, intervalMs: 1000 };
export function BarReplayControls({ chart, onActiveChange, hideEntry = false }: { chart: RefObject<ChartHandle | null>; onActiveChange: (active: boolean) => void; hideEntry?: boolean }) {
  const [state, setState] = useState(idle);
  const [speed, setSpeed] = useState(1000);
  const [error, setError] = useState('');
  useEffect(() => {
    const read = () => {
      const next = chart.current?.replayStatus() ?? idle;
      setState(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      onActiveChange(next.active || next.armed || next.busy);
    };
    read(); const timer = window.setInterval(read, 200);
    return () => window.clearInterval(timer);
  }, [chart, onActiveChange]);
  const choosing = state.armed || state.busy;
  const entered = state.active || choosing;
  return <div className={`bar-replay ${entered ? 'is-replaying' : ''}`}>
    {hideEntry ? null : (
      <button type="button" className={`tool-btn ${entered ? 'is-active' : ''}`} disabled={!state.available || state.busy}
        aria-pressed={entered} onClick={() => { setError(''); chart.current?.replaySelect(); }}>◀ 回放{state.active ? ' · 重选起点' : ''}</button>
    )}
    {entered && <>
      {choosing ? <><span role="status">{state.busy ? '正在准备回放…' : '点击图表中的 K 线选择起点'}</span>
        <button type="button" className="tool-btn" disabled={state.busy} onClick={() => {
          setError(''); void chart.current?.replayStartFromView().catch(error => setError(error instanceof Error ? error.message : String(error)));
        }}>从当前视图开始</button></> : <>
        <button type="button" className="tool-btn" aria-label={state.playing ? '暂停回放' : '播放回放'} onClick={() => state.playing ? chart.current?.replayPause() : chart.current?.replayPlay(speed)}>{state.playing ? 'Ⅱ 暂停' : '▶ 播放'}</button>
        <button type="button" className="tool-btn" title="按各窗格中下一根最早收盘的K线推进" onClick={() => chart.current?.replayStep()}>逐根前进</button>
        <label>速度 <select aria-label="回放速度" value={speed} onChange={event => {
          const value = Number(event.target.value); setSpeed(value); if (state.playing) chart.current?.replayPlay(value);
        }}><option value={2000}>0.5×</option><option value={1000}>1×</option><option value={500}>2×</option><option value={200}>5×</option></select></label>
        <span className="replay-clock" role="status" title="所有窗格均只显示此时刻已经收盘的K线">回放时钟 {state.clockTime ? stamp(state.clockTime / 1000) : '准备中'} · 当前格余 {state.remaining} 根</span>
      </>}
      <button type="button" className="tool-btn" onClick={() => { chart.current?.replayStop(); setError(''); }}>退出回放</button>
    </>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
