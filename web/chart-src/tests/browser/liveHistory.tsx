import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChartWorkspace, type ChartHandle } from '../../src/vela/ChartWorkspace';
import { LiveProvider } from '../../src/vela/provider';
import { mergeLiveHistory } from '../../src/liveHistory';
import '../../src/styles.css';

// Synthetic bars only. No account, EA socket, upload or trade command is used.
const start = 1793491200;
const gapMode = new URLSearchParams(location.search).has('gap');
function bar(index: number) {
  const close = 3900 + index / 30 + Math.sin(index / 20) * 4;
  return [start + index * 60, close - 0.2, close + 0.5, close - 0.7, close, 10];
}
function App() {
  const handle = useRef<ChartHandle>(null);
  const cache = useRef({ M1: Array.from({ length: 1990 }, (_, i) => bar(i + 1000)).concat(gapMode ? [bar(3090)] : []) });
  const listeners = useRef(new Set<() => void>());
  const provider = useMemo(() => new LiveProvider(cache.current, 'HISTORYQA', (cb) => {
    listeners.current.add(cb); return () => listeners.current.delete(cb);
  }), []);
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState('等待真实 Vela 图表就绪');
  useEffect(() => {
    let stopped = false;
    const timer = setInterval(async () => {
      const ws = (window as any).__tpChart;
      const chart = ws?.cells?.()[0]?.chart;
      if (!chart) return;
      clearInterval(timer);
      await chart.ready(); await chart.historyComplete();
      handle.current?.setLayout('1');
      if (!stopped) { setReady(true); setResult('真实图表就绪：可以验收历史扩展和后续实时更新'); }
    }, 100);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  const verify = async () => {
    setReady(false);
    try {
      const ws = (window as any).__tpChart;
      const chart = ws.cells()[0].chart;
      const range = chart.getVisibleRange();
      const firstIndex = (cache.current.M1[0][0] - start) / 60 - 1000;
      const nextIndex = (cache.current.M1.at(-1)![0] - start) / 60 + 1;
      const target = cache.current.M1.length + 1000;
      let history: any = null, live: any = null;
      const offHistory = chart.on('history:complete', (value: any) => { history = value; });
      const offBar = chart.on('bar', (value: any) => { live = value; });
      cache.current.M1 = Array.from({ length: 1000 }, (_, i) => bar(i + firstIndex)).concat(cache.current.M1);
      await handle.current!.applySeries('M1', cache.current.M1);
      const after = chart.getVisibleRange();
      mergeLiveHistory(cache.current, { M1: [bar(nextIndex)] });
      for (const cb of [...listeners.current]) cb();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      offHistory(); offBar();
      const report = {
        renderedBars: history?.barsLoaded, oldestTime: history?.oldestTime,
        preservedView: Math.abs(range.from - after.from) < 1 && Math.abs(range.to - after.to) < 1,
        liveTime: live?.time, expectedLiveTime: bar(nextIndex)[0] * 1000,
        subscriptions: listeners.current.size,
      };
      if (report.renderedBars !== target || report.oldestTime !== bar(firstIndex)[0] * 1000 || !report.preservedView
        || report.liveTime !== report.expectedLiveTime || !report.subscriptions) throw new Error(JSON.stringify(report));
      setResult(`通过：真实图表增加 1000 根，现有 ${target} 根；视窗不变，下一根实时 K 线仍收到。\n`+JSON.stringify(report, null, 2));
      chart.setVisibleRange({ from: bar(firstIndex)[0] * 1000, to: bar(firstIndex + 1200)[0] * 1000 });
      setReady(true);
    } catch (error) { setResult('失败：'+String(error)); }
  };
  const verifyGap = async () => {
    setReady(false);
    try {
      const chart = (window as any).__tpChart.cells()[0].chart;
      const range = chart.getVisibleRange();
      const spacing = chart.rendererControl.renderer.coords.getViewport().barSpacing;
      let history: any = null, live: any = null;
      const offHistory = chart.on('history:complete', (event: any) => { history = event; });
      const offBar = chart.on('bar', (event: any) => { live = event; });
      mergeLiveHistory(cache.current, { M1: Array.from({ length: 100 }, (_, i) => bar(i + 2990)) });
      await handle.current!.applySeries('M1', cache.current.M1, undefined, true);
      const after = chart.getVisibleRange();
      mergeLiveHistory(cache.current, { M1: [bar(3091)] });
      for (const cb of [...listeners.current]) cb();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      offHistory(); offBar();
      const report = { renderedBars: history?.barsLoaded, expectedBars: 2091,
        beforeFrom: range.from, afterFrom: after.from,
        preservedLeft: Math.abs(range.from-after.from)<=60000,
        preservedZoom: spacing === chart.rendererControl.renderer.coords.getViewport().barSpacing,
        liveTime: live?.time, expectedLiveTime: bar(3091)[0]*1000, subscriptions: listeners.current.size };
      if (report.renderedBars!==2091 || !report.preservedLeft || !report.preservedZoom || report.liveTime!==report.expectedLiveTime || !report.subscriptions) throw new Error(JSON.stringify(report));
      setResult('通过：中间缺失的100根已进入真实图表，实时订阅继续，缩放与左侧定位保持。\n'+JSON.stringify(report,null,2));
      chart.setVisibleRange({ from: bar(2950)[0]*1000, to: bar(3091)[0]*1000 });
    } catch (error) { setResult('失败：'+String(error)); }
  };
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', padding: 12, boxSizing: 'border-box', gap: 8 }}>
    <strong>真实图表验收 · 合成行情数据</strong>
    <button disabled={!ready} onClick={() => void (gapMode ? verifyGap() : verify())}>{gapMode ? '验证补齐中间100根缺口，并继续实时行情' : '验证补入 1000 根历史，并继续实时行情'}</button>
    <pre role="status" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{result}</pre>
    <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}><ChartWorkspace ref={handle} charts={cache.current}
      symbol="HISTORYQA" anchorMs={0} savedState={null} readOnly={false} timeframes={['1']}
      provider={provider} providerName="historyqa" onError={(error) => setResult('图表错误：'+error)} /></div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
