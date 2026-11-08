/** Keep saved splitter proportions where they fit, giving cramped tracks room first. */
export function fitTrackWeights(weights: readonly number[], width: number, minimum = 240): number[] {
  if (!weights.length || !Number.isFinite(width) || width <= 0 ||
      !Number.isFinite(minimum) || minimum <= 0 ||
      weights.some(weight => !Number.isFinite(weight) || weight <= 0)) return [...weights];
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const floor = Math.min(minimum, width / weights.length) / width * total;
  if (weights.every(weight => weight >= floor)) return [...weights];
  const result = Array<number>(weights.length).fill(0);
  const pending = new Set(weights.map((_, index) => index));
  let remaining = total;
  while (pending.size) {
    const sourceTotal = [...pending].reduce((sum, index) => sum + weights[index]!, 0);
    const cramped = [...pending].filter(index => weights[index]! / sourceTotal * remaining < floor);
    if (!cramped.length) {
      for (const index of pending) result[index] = weights[index]! / sourceTotal * remaining;
      break;
    }
    for (const index of cramped) {
      result[index] = floor;
      remaining -= floor;
      pending.delete(index);
    }
  }
  return result;
}

/**
 * Adjust only the active layout's saved column sizes before Vela restores the document.
 * No cell, drawing, indicator, dormant layout or row size is rewritten. At widths too
 * small for the minimum, equal columns are the least cramped possible arrangement.
 * `width` is the grid content width (excluding the external drawing toolbar).
 */
export function fitSavedWorkspaceTracks<T>(state: T, width: number, minimum = 240): T {
  if (!state || typeof state !== 'object' || !Number.isFinite(width) || width <= 0) return state;
  const document = state as Record<string, unknown>;
  if (typeof document.layout !== 'string' || !document.trackSizes || typeof document.trackSizes !== 'object') return state;
  const tracks = document.trackSizes as Record<string, unknown>;
  const active = tracks[document.layout];
  if (!active || typeof active !== 'object') return state;
  const columns = (active as Record<string, unknown>).cols;
  if (!Array.isArray(columns) || columns.length < 2 || columns.some(value => typeof value !== 'number')) return state;
  const fitted = fitTrackWeights(columns, Math.max(1, width - columns.length + 1), minimum);
  if (fitted.every((value, index) => Math.abs(value - columns[index]) < 1e-9)) return state;
  return {
    ...document,
    trackSizes: { ...tracks, [document.layout]: { ...active, cols: fitted } },
  } as T;
}
