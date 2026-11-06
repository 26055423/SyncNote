import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChartWorkspace, type ChartHandle } from '../../src/vela/ChartWorkspace';
import { aggregate, type ReviewCharts } from '../../src/vela/provider';
import '../../src/styles.css';

// This fixture has no LiveProvider, terminal, credentials, upload or trade command.
// Keep the original snapshot immutable: mutating it would hide a stale ReviewProvider.
const friday = Date.UTC(2026, 10, 6, 12) / 1000;
const monday = Date.UTC(2026, 10, 9, 0) / 1000;
function row(time: number) {
  const close = 4000 + Math.sin(time / 40000) * 12;
  return [time, close - 0.2, close + 0.6, close - 0.7, close, 10];
}
const before = Array.from({ length: 720 }, (_, index) => row(friday + index * 60));
const future = Array.from({ length: 720 }, (_, index) => row(monday + index * 60));
const combined = [...before, ...future];
const initialSnapshot: ReviewCharts = {
  M1: before, M5: aggregate(before, 300), M15: aggregate(before, 900), H1: aggregate(before, 3600),
};
const frames = async () => {
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
};
function measure(cell: any) {
  // Test-only reads of the actual native geometry; production need not expose a test API.
  const coords = cell.chart.rendererControl.renderer.coords;
  const range = cell.chart.getVisibleRange();
  return { id: cell.id, timeframe: cell.chart.market.timeframe, bars: coords.barCount,
    first: coords.barCount ? coords.logicalToTime(0) : null,
    last: coords.barCount ? coords.logicalToTime(coords.barCount - 1) : null,
    spacing: coords.getViewport().barSpacing, from: range?.from ?? null, to: range?.to ?? null };
}
const describe = (stage: string, value: unknown) => new Error(stage + '：' + JSON.stringify(value));

function App() {
  const handle = useRef<ChartHandle>(null);
  const snapshot = useRef(initialSnapshot);
  const [status, setStatus] = useState<'loading' | 'ready' | 'running' | 'passed' | 'failed'>('loading');
  const [result, setResult] = useState('等待静态 ReviewProvider 和四周期真实图表就绪。');
  const workspace = () => (window as any).__tpChart;
  const readyCells = async () => {
    await frames();
    const cells = workspace()?.cells() ?? [];
    await Promise.all(cells.map(async (cell: any) => { await cell.chart.ready(); await cell.chart.historyComplete(); }));
    await frames();
    return cells;
  };
  const assertFresh = (stage: string, cells: any[], exactDepth?: number) => {
    const rows = cells.filter(cell => cell.chart.market.timeframe === '1').map(measure);
    // A newly opened provider-backed cell may legitimately request only its default depth.
    if (rows.length < 2 || rows.some(item => item.bars < 2 || (exactDepth !== undefined && item.bars !== exactDepth)
      || item.last !== combined.at(-1)![0] * 1000)) throw describe(stage, rows);
    return rows;
  };
  const verify = async () => {
    setStatus('running');
    setResult('正在验证周末后补段、同周期多格更新、周期和布局恢复。');
    try {
      const cells = await readyCells();
      if (cells.length !== 4) throw describe('初始布局缺少四格', cells.map(measure));
      // Two M1 cells must follow one source, even if the caller names only the first.
      await cells[1].chart.setMarket({ timeframe: '1' });
      await readyCells();
      const minuteCells = cells.filter((cell: any) => cell.chart.market.timeframe === '1');
      if (minuteCells.length !== 2) throw describe('准备同基础周期两格失败', cells.map(measure));
      for (const cell of minuteCells) cell.chart.setVisibleRange({ from: before[360][0] * 1000, to: before[480][0] * 1000 });
      await frames();
      const original = new Map(minuteCells.map((cell: any) => [cell.id, measure(cell)]));
      await handle.current!.applySeries('M1', combined, minuteCells[0].id);
      await readyCells();
      const appended = assertFresh('补段没有更新全部M1格', cells, combined.length);
      for (const value of appended) {
        const old = original.get(value.id)!;
        if (Math.abs(value.spacing - old.spacing) > 0.00001 || value.from === null || old.from === null || Math.abs(value.from - old.from) > 60000) {
          throw describe('补段改变缩放或左侧定位', { before: old, after: value });
        }
      }
      if (snapshot.current.M1 !== before || snapshot.current.M1.length !== 720) throw describe('原始快照被意外修改', snapshot.current.M1?.length);
      // This third cell has never received inline M1 data: it must load the updated source.
      await cells[2].chart.setMarket({ timeframe: '1' });
      const switched = assertFresh('切换周期退回旧快照', await readyCells());
      handle.current!.setLayout('1');
      await readyCells();
      // Exercise the host handle, not direct chart.setMarket: inline M1 data must be cleared.
      handle.current!.setTimeframe('5');
      const fiveCells = await readyCells();
      const five = measure(fiveCells[0]);
      const fiveExpected = initialSnapshot.M5!;
      if (five.timeframe !== '5' || five.bars !== fiveExpected.length || five.last !== fiveExpected.at(-1)![0] * 1000) {
        throw describe('单格切换5m仍残留inline M1数据', { actual: five, expectedBars: fiveExpected.length, expectedLast: fiveExpected.at(-1)![0] * 1000 });
      }
      handle.current!.setTimeframe('1');
      const returnedCell = (await readyCells())[0];
      const returnedMinute = measure(returnedCell);
      if (returnedMinute.timeframe !== '1' || returnedMinute.bars < 2 || returnedMinute.last !== combined.at(-1)![0] * 1000) {
        throw describe('单格切回1m丢失周一尾部', returnedMinute);
      }
      handle.current!.setLayout('4');
      const restored = assertFresh('恢复四格布局退回旧快照', await readyCells());
      const anchor = future[360][0] * 1000;
      handle.current!.focus(anchor);
      await frames();
      const focused = (workspace().cells() as any[]).filter(cell => cell.chart.market.timeframe === '1').map(measure);
      if (focused.some(value => value.from === null || value.to === null || value.from > anchor || value.to < anchor)) throw describe('无法定位周末后数据', focused);
      setStatus('passed');
      setResult('通过：断开EA的静态复盘已补入周一数据；两格M1同时更新、缩放与左侧定位保持；切换周期和布局不退回旧快照。\n'
        + JSON.stringify({ snapshotBars: before.length, extendedBars: combined.length, weekendGapHours: (monday - before.at(-1)![0]) / 3600,
          appended, switched, five, returnedMinute, restored, focused, terminalUsed: false }, null, 2));
    } catch (error) { setStatus('failed'); setResult('失败：' + String(error)); }
  };
  useEffect(() => {
    let stopped = false;
    const timer = setInterval(async () => {
      if (workspace()?.cells()?.length !== 4) return;
      clearInterval(timer);
      await readyCells();
      if (stopped) return;
      setStatus('ready');setResult('就绪：点击验收，无需连接EA。原始快照只有周五，待补数据在周一。');
      if (new URLSearchParams(location.search).get('auto') === '1') void verify();
    }, 100);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', padding: 8, gap: 8, boxSizing: 'border-box' }}>
    <strong>断开EA静态复盘验收 · 合成行情（周五 → 周一）</strong>
    <button disabled={status === 'loading' || status === 'running'} onClick={() => status === 'passed' || status === 'failed' ? location.reload() : void verify()}>
      {status === 'passed' || status === 'failed' ? '重新加载验收页' : '验证后续补段、同周期多格和布局恢复'}
    </button>
    <pre role="status" data-testid="review-history-result" data-status={status} style={{ margin: 0, whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>{result}</pre>
    <div style={{ flex: 1, minHeight: 0, position: 'relative' }}><ChartWorkspace ref={handle} charts={snapshot.current}
      symbol="REVIEWQA" anchorMs={0} savedState={null} readOnly={false} timeframes={['1','5','15','60']} providerName="reviewhistoryqa"
      onError={error => { setStatus('failed');setResult('图表错误：' + error); }} /></div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
