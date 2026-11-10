import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { Board, ShareRow, Tab } from '../workspace/types';

export function useSocialNotifications(board: Board | null, tab: Tab) {
  const [inbox, setInbox] = useState<ShareRow[]>([]);
  const [dmUnread, setDmUnread] = useState<Record<string, number>>({});
  const [groupUnread, setGroupUnread] = useState(0);
  const [friendReq, setFriendReq] = useState<{ incoming: Array<{ id: string; nickname: string; username: string }>; outgoing: Array<{ id: string; nickname: string; username: string }> }>({ incoming: [], outgoing: [] });
  /* ------------------------------------------------- 会话：消息 / 关注 */

  useEffect(() => {
    if (!board?.user.id) return;
    let alive = true, inboxLoading = false;
    const loadInbox = async () => {
      if (inboxLoading) return;
      inboxLoading = true;
      try {
        const r = await api<{ items: ShareRow[] }>('/api/reviews/inbox');
        if (alive) setInbox(r.items);
      } catch {
        /* 下一轮再试 */
      } finally { inboxLoading = false; }
    };
    void loadInbox();
    const loadProfile = () => {
      void api<{ incoming?: any[]; outgoing?: any[] }>('/api/profile')
        .then((r) => {
          if (!alive) return;
          setFriendReq({ incoming: r.incoming ?? [], outgoing: r.outgoing ?? [] });
          void api<{ unread: Record<string, number> | number; threads: Array<{ peer: { id: string }; unread: number }> }>('/api/dm/threads')
            .then((dm) => {
              const map: Record<string, number> = {};
              for (const row of dm.threads ?? []) if (row.unread) map[row.peer.id] = row.unread;
              if (!alive) return;
              setDmUnread(map);
              void api<{ groups: Array<{ unread: number; mentions: number }> }>('/api/groups')
                .then((gs) => { if (alive) setGroupUnread((gs.groups ?? []).reduce((n, g) => n + (g.unread || 0), 0)); })
                .catch(() => undefined);
            })
            .catch(() => undefined);
        })
        .catch(() => undefined);
    };
    loadProfile();
    const profileTimer = window.setInterval(loadProfile, 15000);
    // 分享是社交入口：交易台开着时也要能看到新消息，不能只在刷新页面时更新。
    const timer = window.setInterval(loadInbox, 15000);
    const onVisible = () => { if (document.visibilityState === 'visible') void loadInbox(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.clearInterval(profileTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [board?.user.id]);

  /** 打开「消息」就把未读标成已读：角标和小铃不再闪，下次刷新也不会再算未读。 */
  useEffect(() => {
    if (tab !== 'inbox') return;
    const unread = inbox.filter((row) => !row.seen).map((row) => row.id);
    if (!unread.length) return;
    let alive = true;
    void Promise.all(unread.map((id) => api('/api/reviews/share/seen', { id }).then(() => id).catch(() => null))).then((seen) => {
      if (alive && seen.some((id) => id !== null)) setInbox((rows) => rows.map((row) => (seen.includes(row.id) ? { ...row, seen: true } : row)));
    });
    return () => {
      alive = false;
    };
  }, [tab, inbox]);

  return { inbox, dmUnread, groupUnread, friendReq, setFriendReq };
}
