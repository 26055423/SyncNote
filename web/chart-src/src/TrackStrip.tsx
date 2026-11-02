import { useEffect, useMemo, useState } from 'react';
import { api } from './api';

/**
 * 「数据轨道」：像视频编辑软件那样，一个券商服务器 = 一条轨。
 *
 * - 用户复盘时，数据补进**他自己的券商轨道**（服务端按 source 合并，同券商共用）；
 * - 打开某笔复盘时，这笔交易所属的轨道**提到最上层**并高亮，其余轨道压暗；
 * - 图表只画当前轨道的 K 线（一屏一源），所以这里只做“覆盖率/在哪段有数据”的可视化。
 */

interface Track {
  source: string;
  server: string;
  account: string;
  active: boolean;
  coverage: number;
  blocks: number[][];
  series?: Record<string, { covered_seconds: number; bars: number }>;
}

interface TracksPayload {
  symbol: string;
  from: number;
  to: number;
  active_source: string | null;
  tracks: Track[];
}

export function TrackStrip({ person, ticket, shareId, from, to, refreshKey, headless }: {
  person?: string;
  ticket?: string;
  shareId?: number | null;
  from: number;
  to: number;
  refreshKey?: number;
  /** 放进底部页签时用：不画自己的标题栏（页签已经是标题了）。 */
  headless?: boolean;
}) {
  const [data, setData] = useState<TracksPayload | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (shareId != null) params.set('share', String(shareId));
    else if (person && ticket) {
      params.set('person', person);
      params.set('ticket', ticket);
    } else return null;
    params.set('from', String(Math.max(1, Math.round(from / 1000))));
    params.set('to', String(Math.max(2, Math.round(to / 1000))));
    return params.toString();
  }, [person, ticket, shareId, from, to]);

  useEffect(() => {
    if (!query) return;
    let alive = true;
    api<TracksPayload>('/api/chart/tracks?' + query)
      .then((payload) => {
        if (!alive) return;
        setData(payload);
        setError('');
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      alive = false;
    };
  }, [query, refreshKey]);

  if (!data || !data.tracks.length) {
    if (error) return <div className="tracks tracks-empty"><span>数据轨道：{error}</span></div>;
    return headless
      ? <p className="dim dock-empty">这笔交易还没有轨道数据；同步更多 K 线后会出现。</p>
      : <div className="tracks tracks-empty"><span>这笔交易还没有轨道数据；同步更多 K 线后会出现。</span></div>;
  }

  const span = Math.max(1, data.to - data.from);
  // headless：放进底部「数据轨道」页签时不再重复画标题和收起按钮。
  return <section className={`tracks ${headless ? 'tracks-in-dock' : ''} ${open ? '' : 'is-collapsed'}`}>
    {headless ? null : (
      <header className="tracks-head">
        <b>数据轨道</b>
        <span className="dim">{data.tracks.length} 个券商来源 · 高亮的这条是本笔交易在用的</span>
        <button type="button" className="tool-btn tracks-toggle" onClick={() => setOpen((value) => !value)}>
          {open ? '收起' : '展开'}
        </button>
      </header>
    )}
    {(headless || open) ? data.tracks.map((track) => (
      <div key={track.source} className={`track ${track.active ? 'is-active' : ''}`}>
        <span className="track-name" title={`${track.source} · 账户 ${track.account}`}>
          {track.server || track.source}
        </span>
        <div className="track-lane">
          {(track.blocks || []).map((block, index) => {
            const left = ((block[0] - data.from) / span) * 100;
            const width = Math.max(0.35, ((block[1] - block[0]) / span) * 100);
            return <i key={index} className="track-block" style={{ left: `${left}%`, width: `${width}%` }} />;
          })}
        </div>
        <span className="track-pct">{Math.round(track.coverage * 100)}%</span>
        {track.active ? <span className="track-badge">正在使用</span> : null}
      </div>
    )) : null}
  </section>;
}
