import { createRoot } from 'react-dom/client';
import { LocalTradePanel } from '../../src/LocalTradePanel';
import { localTerminal } from '../../src/localTerminal';
import '../../src/styles.css';
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';

// Generated display-only data. No WebSocket is opened; controls are inert.
const state = { ...localTerminal.getSnapshot(), phase: 'connected' as const,
  account_id: 'DEMO-001', server: 'Example-Trading-Server', read_only: false,
  demo: false, real_trading: true, hedging: true, quota_unrestricted: true,
  capabilities: ['market', 'limit', 'stop'], symbol: 'XAUUSD', latency: 10,
  account: { balance: 1000, equity: 1000, currency: 'USD' },
  tick: { bid: 4064.97, ask: 4065.71 },
  historyWarnings: { '1m': '1m：MT5 尚未准备好所请求范围的 K 线。' },
};
createRoot(document.getElementById('root')!).render(<main style={{ width: 340, maxWidth: '100%', margin: '16px auto', padding: 12, boxSizing: 'border-box', background: 'var(--panel)' }}>
  <p className="dim">布局验收 · 虚构数据 · 不连接 EA</p>
  <div onClickCapture={(event) => { event.preventDefault(); event.stopPropagation(); }}><LocalTradePanel state={state} /></div>
</main>);
