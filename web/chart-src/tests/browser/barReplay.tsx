import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChartWorkspace, type ChartHandle } from '../../src/vela/ChartWorkspace';
import { BarReplayControls } from '../../src/BarReplayControls';
import { aggregate, TIMEFRAMES, type ReviewCharts } from '../../src/vela/provider';
import '../../src/styles.css';

// Isolated, deterministic candles. No terminal, account, credential or API request.
const origin = Date.UTC(2026, 10, 5, 0) / 1000;
const row = (index: number) => {
  const close = 4000 + index * 0.02 + Math.sin(index / 19) * 4;
  return [origin + index * 60, close - 0.2, close + 0.6, close - 0.8, close, 10 + index % 20];
};
const initial = Array.from({ length: 600 }, (_, index) => row(index));
const appended = [...initial, ...Array.from({ length: 10 }, (_, index) => row(600 + index))];
const charts: ReviewCharts = { M1: initial, M5: aggregate(initial, 300), M15: aggregate(initial, 900), H1: aggregate(initial, 3600) };
const snapshot = JSON.stringify(charts);
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('超时：' + description);
    await frame();
  }
  await frame();
}
function measure(cell: any) {
  // Test-only native geometry inspection. Production replay uses only public APIs.
  const coords = cell.chart.rendererControl.renderer.coords;
  return { id: cell.id, tf: cell.chart.market.timeframe, count: coords.barCount,
    last: coords.barCount ? coords.logicalToTime(coords.barCount - 1) : null,
    active: cell.chart.replay.state.active };
}
function require(value: unknown, message: string, details?: unknown): asserts value {
  if (!value) throw new Error(message + (details === undefined ? '' : '：' + JSON.stringify(details)));
}

function App() {
  const handle = useRef<ChartHandle>(null);
  const [status, setStatus] = useState('loading');
  const [report, setReport] = useState('等待四周期真实工作区就绪。');
  const [active, setActive] = useState(false);
  const started = useRef(false);
  const cells = () => ((window as any).__tpChart?.cells() ?? []) as any[];
  const verify = async () => {
    if (started.current) return;
    started.current = true;
    setStatus('running');
    try {
      await until(() => cells().length === 4 && Boolean(handle.current?.replayStatus().available)
        && cells().every(cell => measure(cell).count > 1), '图表和行情加载');
      await Promise.all(cells().map(async cell => { await cell.chart.ready(); await cell.chart.historyComplete(); }));
      const original = cells().map(measure);
      const cancelledStart = handle.current!.replayStartFromView();
      handle.current!.replayStop();
      await cancelledStart;
      await frame(); await frame();
      require(!handle.current!.replayStatus().active, '准备期间退出后，迟到的start重新开启回放');
      await handle.current!.replayStartFromView();
      await until(() => Boolean(handle.current?.replayStatus().active), '开始回放');
      const state = handle.current!.replayStatus();
      const hidden = cells().map(measure);
      require(state.clockTime, '回放缺少共享时钟', state);
      for (const cell of hidden) {
        const period = TIMEFRAMES[cell.tf]?.seconds;
        require(period && cell.last !== null && cell.last + period * 1000 <= state.clockTime, '窗格泄漏未收盘未来K线', { cell, state });
      }
      require(hidden.find(cell => cell.tf === '1')!.count < original.find(cell => cell.tf === '1')!.count, 'M1后续行情没有隐藏');
      await handle.current!.applySeries('M1', appended);
      await frame(); await frame();
      const duringUpdate = cells().map(measure);
      require(handle.current!.replayStatus().active, '增量更新意外终止回放');
      require(JSON.stringify(duringUpdate) === JSON.stringify(hidden), '回放期间的未来增量进入画面', { hidden, duringUpdate });
      handle.current!.replayStep();
      await until(() => (handle.current?.replayStatus().clockTime ?? 0) > state.clockTime!, '逐根推进');
      const stepped = handle.current!.replayStatus();
      handle.current!.replayStop();
      await until(() => !handle.current!.replayStatus().active
        && cells().filter(cell => cell.chart.market.timeframe === '1').every(cell => measure(cell).count === appended.length), '退出后恢复缓存的新增行情');
      const restored = cells().map(measure);
      require(restored.find(cell => cell.tf === '1')!.last === appended.at(-1)![0] * 1000, '退出后丢失新增末根');
      require(JSON.stringify(charts) === snapshot && initial.length === 600, '原始快照被改写');
      setReport('通过：未来行情在回放期间保持隐藏；逐根推进共享时钟；退出恢复完整历史与新增10根；原始快照未改。\n'
        + JSON.stringify({ cancelledStartRemainedStopped: true, original, hidden, duringUpdate, stepped, restored, originalSnapshotUnchanged: true }, null, 2));
      setStatus('passed');
    } catch (error) {
      setStatus('failed'); setReport(String(error));
    }
  };
  useEffect(() => {
    if (new URLSearchParams(location.search).get('auto') === '1') void verify();
    else setStatus('ready');
  }, []);
  return <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    <header className="chart-toolbar"><strong>回放增量隔离验收 · 合成行情</strong>
      <BarReplayControls chart={handle} onActiveChange={setActive}/>
      <button className="tool-btn" disabled={status === 'running' || started.current} onClick={() => void verify()}>验证回放与增量隔离</button>
      <span>{active ? '回放中' : '完整行情'}</span>
    </header>
    <pre data-testid="replay-check" data-status={status} style={{ maxHeight: '25vh', overflow: 'auto', margin: 0, padding: 8, fontSize: 11 }}>{report}</pre>
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <ChartWorkspace ref={handle} charts={charts} symbol="REPLAYQA" providerName="replayguardqa" anchorMs={(origin + 300 * 60) * 1000}
        savedState={null} readOnly={false} forceLayout="4" timeframes={['1', '5', '15', '60']} onError={error => { setReport(error); setStatus('failed'); }}/>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
