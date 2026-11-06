import { useId, useState } from 'react';
import { api } from './api';

/** SyncNote's cloud history permission is separate from SyncTrade's local WS. */
export function SyncNotePairing() {
  const id = useId();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);

  return <section className="link-block" aria-labelledby={`${id}-title`}>
    <header className="link-head"><h3 id={`${id}-title`}>SyncNote 只读同步</h3><span className="link-state">EA → 网站</span></header>
    <p className="dim">挂载 SyncNote 后，将 EA 图表上的 8 位同步配对码填到这里。MT5 运行时，关闭网页也会继续同步成交与 K 线。</p>
    <form className="local-pair" onSubmit={async (event) => {
      event.preventDefault();
      if (busy || !/^\d{8}$/.test(code)) return;
      setBusy(true); setMessage('正在提交配对码…'); setError(false);
      try {
        await api('/api/mt5/device/claim', { code });
        setCode('');
        setMessage('请回 MT5 图表核对同频账号并点击「允许只读同步」。完成授权并上传后，个人中心才会显示最近同步时间。');
      } catch (err) {
        setError(true); setMessage(err instanceof Error ? err.message : '配对请求失败，请稍后重试');
      } finally { setBusy(false); }
    }}>
      <label htmlFor={`${id}-code`}>SyncNote 图表上的 8 位同步配对码</label>
      <div className="local-buttons">
        <input id={`${id}-code`} aria-describedby={`${id}-help ${id}-status`} autoComplete="off" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} placeholder="00000000" disabled={busy} />
        <button className="primary" type="submit" disabled={busy || !/^\d{8}$/.test(code)}>{busy ? '提交中…' : '配对同步'}</button>
      </div>
      <p className="dim" id={`${id}-help`}>配对码 10 分钟内有效；仅授权数据同步，与 SyncTrade 的交易配对码分开。过期或拒绝后，在 EA 点击「重新生成配对码」，再填写新码。</p>
      <p id={`${id}-status`} className={error ? 'local-error' : 'dim'} role={error ? 'alert' : 'status'} aria-live="polite">{message}</p>
    </form>
    <a href="/local-ea" target="_blank" rel="noopener noreferrer">下载与安装 SyncNote ↗</a>
    <span className="dim"> · </span><a href="/profile#assistant-panel">查看同步状态 ↗</a>
  </section>;
}
