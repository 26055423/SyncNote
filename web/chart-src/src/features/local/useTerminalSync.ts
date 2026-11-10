import { useEffect } from 'react';
import { localTerminal, useLocalTerminal } from '../../localTerminal';
import { localHistorySync, useLocalHistorySync } from '../../localHistorySync';
import { localRangeSync } from '../../localRangeSync';
import { backfillBars, useBackfillBars } from '../../backfillBars';
import type { Board } from '../workspace/types';

export function useTerminalSync(board: Board | null, local: ReturnType<typeof useLocalTerminal>, backfill: ReturnType<typeof useBackfillBars>, historySync: ReturnType<typeof useLocalHistorySync>) {
  const localConnected = local.phase === 'connected';
  useEffect(() => () => localTerminal.disconnect(), []);

  /* 本机已连接时离开页面会丢配对令牌：先给一次浏览器级确认。 */
  useEffect(() => {
    if (!localConnected) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [localConnected]);

  useEffect(() => {
    localHistorySync.bindUser(board?.user.id || '');
    backfillBars.bindUser(board?.user.id || '');
    localRangeSync.bindUser(board?.user.id || '');
  }, [board?.user.id]);

  // 有续传授权时先确认最近成交，再让 K 线补齐争用同一个本机历史通道。
  const waitForRecentDeals = board?.user.auto_history_sync && !historySync.recent_ready && historySync.status !== 'error';
  // 连上 EA 后只在后台补近7天缺口，不锁轨道图，也不恢复旧的多年回溯。
  // error 态不在此自动重试(否则 error→initializing→error 无退避空转);重连会话变化会被
  // backfillBars 内部 stop 回 idle,那时再由本 effect 重启。
  useEffect(() => {
    if (!board?.user.id || !localConnected || !local.history_ready || !local.features.includes('history')) return;
    if (backfill.phase !== 'idle' || waitForRecentDeals) return;
    void backfillBars.start();
  }, [board?.user.id, localConnected, local.history_ready, local.features, backfill.phase, waitForRecentDeals]);

  // 个人中心勾了「自动续传」后，连接一旦可读就先上传近期成交。
  useEffect(() => {
    if (!board?.user.id) return;
    if (!board.user.auto_history_sync) {
      if (localHistorySync.getSnapshot().enabled) localHistorySync.stop();
      return;
    }
    if (!localConnected || !local.history_ready) return;
    if (!local.features.includes('history')) return;
    if (localHistorySync.getSnapshot().enabled) return;
    void localHistorySync.start().catch(() => undefined);
  }, [board?.user.id, board?.user.auto_history_sync, localConnected, local.history_ready, local.features, local.epoch, local.account_id, local.server]);

  useEffect(() => {
    const pause = () => { localHistorySync.stop('网页已关闭，笔记同步已暂停。'); backfillBars.stop('网页已关闭，行情回填已暂停。'); localRangeSync.stop('网页已关闭，SyncTrade 区间同步已暂停。'); };
    window.addEventListener('pagehide', pause);
    return () => { window.removeEventListener('pagehide', pause); pause(); };
  }, []);

}
