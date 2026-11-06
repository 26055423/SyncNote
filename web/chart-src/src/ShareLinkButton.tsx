import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * 「对外链接」：生成一条只读分享链接，效果等价于把这一笔复盘发给任何拿到链接的人。
 * 权限边界在服务端：链接只能读这一笔交易的快照，撤销立即失效。
 */
export function ShareLinkButton({ ticket }: { ticket: string }) {
  const [token, setToken] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setToken('');
    setHint('');
    setError('');
    if (!ticket) return;
    void api<{ token: string | null }>(`/api/share-links?ticket=${encodeURIComponent(ticket)}`)
      .then((res) => { if (alive) setToken(res?.token || ''); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [ticket]);

  const copy = async (url: string) => {
    const absolute = `${location.origin}${url}`;
    try {
      await navigator.clipboard.writeText(absolute);
      setHint('链接已复制');
    } catch {
      setHint(`复制失败，手动复制：${absolute}`);
    }
    window.setTimeout(() => setHint(''), 6000);
  };

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ token: string; url: string }>('/api/share-links', { ticket });
      setToken(res.token);
      await copy(res.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/share-links', { ticket, revoke: true });
      setToken('');
      setHint('链接已取消');
      window.setTimeout(() => setHint(''), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="local-buttons">
        <button type="button" className="tool-btn" disabled={busy || !ticket} onClick={() => void (token ? copy(`/s/${token}`) : create())}>
          {busy ? '处理中…' : token ? '复制对外链接' : '生成对外链接'}
        </button>
        {token ? <button type="button" className="link" disabled={busy} onClick={() => void revoke()}>取消链接</button> : null}
      </div>
      {token ? <p className="dim">任何拿到链接的人都能看这一笔（摘要 + 笔记 + K 线），不含账户与其它交易。</p> : null}
      {hint ? <p className="dim" role="status">{hint}</p> : null}
      {error ? <p className="local-error">{error}</p> : null}
    </>
  );
}
