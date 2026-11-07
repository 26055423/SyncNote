export interface PairingTerminal {
  getSnapshot(): { phase: string; error: string };
  subscribe(listener: () => void): () => void;
  connect(): void;
  disconnect(): void;
  pair(code: string): void;
}

/** Send the code once, after the local EA's compatible hello. Never retry a pair. */
export function pairLocalMT5(terminal: PairingTerminal, code: string, signal: AbortSignal, timeoutMs = 12000): Promise<void> {
  if (!/^\d{8}$/.test(code)) return Promise.reject(new Error('请输入 8 位配对码'));
  if (['connected', 'confirming'].includes(terminal.getSnapshot().phase)) return Promise.reject(new Error('已有本机连接，请先断开再连接其他 EA。'));
  return new Promise((resolve, reject) => {
    let sent = false, settled = false, unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; unsubscribe(); clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (error) { terminal.disconnect(); reject(error); } else resolve();
    };
    const cancel = () => finish(new Error('连接已取消'));
    const inspect = () => {
      if (settled) return;
      const state = terminal.getSnapshot();
      if (state.phase === 'error' || state.error) { finish(new Error(state.error || '无法连接本机 EA')); return; }
      if (state.phase === 'confirming' || state.phase === 'connected') { finish(); return; }
      if (state.phase === 'pairing' && !sent) {
        sent = true;
        try { terminal.pair(code); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      }
    };
    if (signal.aborted) { reject(new Error('连接已取消')); return; }
    signal.addEventListener('abort', cancel, { once: true });
    unsubscribe = terminal.subscribe(inspect);
    timer = setTimeout(() => finish(new Error('未找到可配对的 EA，请核对配对码、EA 是否运行及浏览器的本机网络权限。')), timeoutMs);
    try { terminal.connect(); inspect(); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
