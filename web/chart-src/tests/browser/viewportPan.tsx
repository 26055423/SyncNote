import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChartWorkspace, type ChartHandle } from '../../src/vela/ChartWorkspace';
import { LiveProvider, type ReviewCharts } from '../../src/vela/provider';
import { mergeLiveHistory } from '../../src/liveHistory';
import '../../src/styles.css';

const now = 1793865600, oldTip = now - 72 * 3600;
const periods = { M1: 60, M5: 300, M15: 900, H1: 3600 } as const;
function row(time: number) {
  const close = 4000 + Math.sin(time / 200000) * 15;
  return [time, close - 1, close + 2, close - 2, close, 10];
}
function App() {
  const handle = useRef<ChartHandle>(null), listeners = useRef(new Set<() => void>());
  const cache = useRef<ReviewCharts>(Object.fromEntries(Object.entries(periods).map(([tf, period]) => [tf,
    tf === 'M1' ? Array.from({ length: 10000 }, (_, i) => row(now - (9999-i)*period))
      : [...Array.from({ length: 600 }, (_, i) => row(oldTip - (599-i)*period)), row(now)]
  ])));
  const provider = useMemo(() => new LiveProvider(cache.current, 'PANQA', (cb) => {
    listeners.current.add(cb); return () => listeners.current.delete(cb);
  }), []);
  const baseline = useRef<Record<string, number>>({});
  const positions = useRef<Record<string, number>>({});
  const [ready, setReady] = useState(false), [result, setResult] = useState('等待四周期真实图表');
  const cells = () => (window as any).__tpChart?.cells() ?? [];
  // Geometry is read only in this test fixture; production uses the public panBy API.
  const spacing = (cell: any) => cell.chart.rendererControl.renderer.coords.getViewport().barSpacing;
  useEffect(() => {
    const timer = setInterval(async () => {
      if (cells().length !== 4) return;
      clearInterval(timer);
      await Promise.all(cells().map(async (cell: any) => { await cell.chart.ready(); await cell.chart.historyComplete(); }));
      setReady(true); setResult('就绪，点击准备，然后在左上1m图内左右拖动。');
    }, 100);
    return () => clearInterval(timer);
  }, []);
  const prepare = () => {
    if (!handle.current!.getSyncs().viewport) handle.current!.toggleSync('viewport');
    for (const cell of cells()) {
      const tf = cell.chart.market.timeframe, period = tf === '1' ? 60 : tf === '5' ? 300 : tf === '15' ? 900 : 3600;
      const from = tf === '1' ? now - 90*3600 : oldTip - 99*period;
      const to = tf === '1' ? now - 42*3600 : oldTip;
      cell.chart.setVisibleRange({ from: from*1000, to: to*1000 });
      baseline.current[cell.id] = spacing(cell);
      positions.current[cell.id] = cell.chart.getVisibleRange()?.from;
    }
    setResult('已准备：5m/15m/1h有72小时缺口。请在左上1m图中左右拖动，再点击验证。');
  };
  const verify = async () => {
    setReady(false);
    try {
      const dragged = cells().map((cell: any) => ({ tf: cell.chart.market.timeframe,
        before: baseline.current[cell.id], afterDrag: spacing(cell), moved: cell.chart.getVisibleRange()?.from !== positions.current[cell.id] }));
      if (!dragged[0].moved || !dragged.slice(1).some((entry: any) => entry.moved)) throw new Error('尚未验证实际1m拖动与其他周期平移：'+JSON.stringify(dragged));
      if (dragged.some((entry: any) => Math.abs(entry.before-entry.afterDrag)>0.00001)) throw new Error('拖动改变其他周期缩放：'+JSON.stringify(dragged));
      for (const base of Object.keys(periods) as Array<keyof typeof periods>) await handle.current!.applySeries(base, cache.current[base]!, undefined, true);
      const report = cells().map((cell: any, i: number) => ({ ...dragged[i], afterReload: spacing(cell) }));
      if (report.some((entry: any) => Math.abs(entry.before-entry.afterReload)>0.00001)) throw new Error('后台刷新改变缩放：'+JSON.stringify(report));
      for (const [base, period] of Object.entries(periods)) mergeLiveHistory(cache.current, { [base]: [row(now+period)] });
      for (const cb of [...listeners.current]) cb();
      setResult('通过：1m与其他周期已实际平移，四周期蜡烛宽度不变；后台刷新后缩放不变。\n'+report.map((entry: any) => `${entry.tf}m：拖动前 ${entry.before.toFixed(5)}，拖动后 ${entry.afterDrag.toFixed(5)}，刷新后 ${entry.afterReload.toFixed(5)}`).join('\n')+`\n实时订阅：${listeners.current.size}`);
    } catch (error) { setResult('失败：'+String(error)); }
    finally { setReady(true); }
  };
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', padding: 8, gap: 8, boxSizing: 'border-box' }}>
    <strong>四周期拖动验收 · 合成行情，含72小时缺口</strong>
    <div><button disabled={!ready} onClick={prepare}>准备四周期缺口场景</button> <button disabled={!ready} onClick={() => void verify()}>验证拖动与后台刷新后的缩放</button></div>
    <pre role="status" style={{ margin: 0, whiteSpace: 'pre-wrap', maxHeight: 170, overflow: 'auto' }}>{result}</pre>
    <div style={{ flex: 1, minHeight: 0, position: 'relative' }}><ChartWorkspace ref={handle} charts={cache.current} symbol="PANQA"
      anchorMs={0} savedState={null} readOnly={false} timeframes={['1','5','15','60']} provider={provider} providerName="panqa" /></div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
