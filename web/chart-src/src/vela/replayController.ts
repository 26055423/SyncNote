import { barClose } from '@luxalgo/vela/workspace';

interface Bounds { first: number; last: number }
export interface ReplayCell {
  id: string;
  chart: {
    market: { timeframe?: string };
    replay: { bounds: Bounds | null };
  };
}
interface Workspace {
  cells(): readonly ReplayCell[];
  active?: ReplayCell | null;
  replay: { stop(): unknown; start(options: { from: number; cell?: string }): Promise<void> };
}

/** Native replay keeps at least one bar, so every cell needs a CLOSED bar at the
 * shared clock. Real master timestamps (not a calendar estimate) also handle gaps.
 * Leave at least one master bar hidden so start never silently does nothing. */
export function replayWindow(cells: readonly ReplayCell[], masterId: string, masterOpenTimes: readonly number[]): Bounds | null {
  const master = cells.find(cell => cell.id === masterId);
  if (!master?.chart.replay.bounds || masterOpenTimes.length < 2) return null;
  const firstCloses = cells.map(cell => {
    const bounds = cell.chart.replay.bounds;
    return bounds ? barClose(bounds.first, cell.chart.market.timeframe) : Infinity;
  });
  const earliestClose = Math.max(...firstCloses);
  const bounds = master.chart.replay.bounds;
  const eligible = masterOpenTimes.filter((time, index, times) =>
    Number.isFinite(time) && (index === 0 || time > times[index - 1]) &&
    time >= bounds.first && time < bounds.last &&
    barClose(time, master.chart.market.timeframe) >= earliestClose);
  return eligible.length ? { first: eligible[0], last: eligible[eligible.length - 1] } : null;
}

/** A new start/seek resets the old group first: native startCell deliberately skips
 * cells whose full history has already closed, and must not leave their old cursor. */
export async function safeReplayStart(workspace: Workspace, options: {
  from: number;
  cell?: string;
  masterOpenTimes: readonly number[];
}): Promise<{ from: number; clamped: boolean }> {
  if (!Number.isFinite(options.from)) throw new Error('请选择有效的回放起点');
  const cells = workspace.cells();
  const masterId = options.cell ?? workspace.active?.id ?? cells[0]?.id ?? '';
  const range = replayWindow(cells, masterId, options.masterOpenTimes);
  if (!range) throw new Error('当前各周期没有足够的共同历史，请先加载更多K线或减少图表');
  const requested = Math.max(range.first, Math.min(range.last, options.from));
  let from = range.first;
  for (const time of options.masterOpenTimes) {
    if (time > requested) break;
    if (time >= range.first && time <= range.last) from = time;
  }
  workspace.replay.stop();
  await workspace.replay.start({ from, cell: masterId });
  return { from, clamped: from !== options.from };
}
