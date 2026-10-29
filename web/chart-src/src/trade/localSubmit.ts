import { localTerminal, type LocalCommand } from '../localTerminal';
import type { OrderAttempt, OrderRequest } from './risk';

/** 把下单面板的请求转成 EA 的 `market` 命令，并等它回报结果。 */
export async function submitMarketOrder(request: OrderRequest, key: string): Promise<OrderAttempt> {
  const id = localTerminal.command('market', {
    symbol: request.symbol,
    side: request.side,
    volume: request.volume,
    sl: request.sl,
    tp: request.tp,
    deviation: request.deviation,
  });
  return waitFor(id, key);
}

function mapResult(command: LocalCommand, key: string): OrderAttempt {
  if (command.state === 'completed') {
    return {
      status: null,
      idempotencyKey: key,
      transportError: null,
      result: { ok: true, retcode: command.retcode, order: command.order, deal: command.deal, volume: command.volume },
    };
  }
  if (command.state === 'rejected') {
    return {
      status: null,
      idempotencyKey: key,
      transportError: null,
      result: { ok: false, retcode: command.retcode, error: command.error || 'EA 或券商拒绝该指令' },
    };
  }
  return {
    status: null,
    idempotencyKey: key,
    transportError: command.error || null,
    result: { ok: false, uncertain: true, retcode: command.retcode, order: command.order, deal: command.deal, error: command.error },
  };
}

function waitFor(id: string, key: string, timeoutMs = 15000): Promise<OrderAttempt> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      const command = localTerminal.getSnapshot().commands.find((row) => row.command_id === id);
      if (!command) {
        resolve({ status: null, idempotencyKey: key, transportError: 'EA 没有返回这条指令', result: null });
        return;
      }
      if (['completed', 'rejected', 'uncertain', 'not_found'].includes(command.state)) {
        resolve(mapResult(command, key));
        return;
      }
      if (Date.now() - started > timeoutMs) {
        resolve({
          status: null,
          idempotencyKey: key,
          transportError: '等待回报超时，请查询结果或到 MT5 核对',
          result: { ok: false, uncertain: true },
        });
        return;
      }
      window.setTimeout(poll, 120);
    };
    poll();
  });
}
