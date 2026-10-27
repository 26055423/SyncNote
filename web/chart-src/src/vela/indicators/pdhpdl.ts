import {
  registerNativeIndicator,
  type InputValue,
  type NativeIndicator,
  type NativeIndicatorContext,
  type NativeIndicatorDescriptor,
  type NativeIndicatorOutput,
  type OHLCV,
} from '@luxalgo/vela';

/**
 * Template for a hand-written (non-Pine) Vela indicator.
 *
 * A native indicator is plain TypeScript: a pure `compute(bars, inputs)` plus the
 * lifecycle hooks the orchestrator drives. There is no Vela-specific scripting
 * language — the 75 built-in studies are written exactly like this.
 *
 * This one draws the previous trading day's high/low (+ optional midpoint) as step
 * lines over the price pane. The "trading day" is bucketed after shifting the bar
 * time by the broker's UTC offset, so a UTC+3 broker's 00:00 session boundary lands
 * where the broker puts it.
 */

const DAY_MS = 86_400_000;

interface DayRange {
  high: number;
  low: number;
}

type Series = NonNullable<NativeIndicatorOutput['series']>;
type Point = { time: number; value: number | null };

function computePreviousDay(
  bars: readonly OHLCV[],
  shiftHours: number,
): { pdh: Point[]; pdl: Point[]; mid: Point[] } {
  const shiftMs = shiftHours * 3_600_000;

  const days = new Map<number, DayRange>();
  for (const bar of bars) {
    const day = Math.floor((bar.time + shiftMs) / DAY_MS);
    const range = days.get(day);
    if (!range) {
      days.set(day, { high: bar.high, low: bar.low });
    } else {
      if (bar.high > range.high) range.high = bar.high;
      if (bar.low < range.low) range.low = bar.low;
    }
  }

  // day -> the range of the day before it
  const previous = new Map<number, DayRange>();
  const keys = [...days.keys()].sort((a, b) => a - b);
  for (let i = 1; i < keys.length; i += 1) {
    const current = keys[i];
    const before = keys[i - 1];
    if (current === undefined || before === undefined) continue;
    const range = days.get(before);
    if (range) previous.set(current, range);
  }

  const pdh: Point[] = [];
  const pdl: Point[] = [];
  const mid: Point[] = [];
  for (const bar of bars) {
    const day = Math.floor((bar.time + shiftMs) / DAY_MS);
    const range = previous.get(day);
    pdh.push({ time: bar.time, value: range ? range.high : null });
    pdl.push({ time: bar.time, value: range ? range.low : null });
    mid.push({ time: bar.time, value: range ? (range.high + range.low) / 2 : null });
  }
  return { pdh, pdl, mid };
}

function buildSeries(bars: readonly OHLCV[], inputs: Record<string, InputValue>): Series {
  const shift = typeof inputs.dayShift === 'number' ? inputs.dayShift : 3;
  const showMid = inputs.showMid !== false;
  const { pdh, pdl, mid } = computePreviousDay(bars, shift);

  const series: Series = [
    {
      id: 'pdh',
      title: 'PDH',
      paneId: '',
      kind: 'step',
      points: pdh,
      style: { color: '#f0a13a', width: 1, lineStyle: 'dashed' },
    },
    {
      id: 'pdl',
      title: 'PDL',
      paneId: '',
      kind: 'step',
      points: pdl,
      style: { color: '#4f8cff', width: 1, lineStyle: 'dashed' },
    },
  ];
  if (showMid) {
    series.push({
      id: 'pd-mid',
      title: 'PD 中位',
      paneId: '',
      kind: 'step',
      points: mid,
      style: { color: '#7c8a9d', width: 1, lineStyle: 'dotted' },
    });
  }
  return series;
}

const descriptor: NativeIndicatorDescriptor = {
  type: 'smc-pdhpdl',
  title: 'PDH / PDL（前日高低）',
  shortTitle: 'PDH',
  paneHint: 'price',
  overlay: true,
  multiInstance: false,
  inputsSchema: () => [
    {
      key: 'dayShift',
      title: '交易日偏移（小时）',
      type: 'int',
      defval: 3,
      min: -12,
      max: 12,
      tooltip: '券商的 UTC 偏移；用来把 00:00 的交易日边界对齐到券商时间。',
    },
    { key: 'showMid', title: '显示中位线', type: 'bool', defval: true },
  ],
  defaultInputs: () => ({ dayShift: 3, showMid: true }),
  create: (): NativeIndicator => {
    let ctx: NativeIndicatorContext | null = null;
    let inputs: Record<string, InputValue> = {};

    const emit = (): void => {
      if (!ctx) return;
      ctx.emit({ series: buildSeries(ctx.bars(), inputs) });
    };

    return {
      start(context, initialInputs) {
        ctx = context;
        inputs = initialInputs;
        emit();
      },
      onBars() {
        emit();
      },
      onViewport() {
        /* not viewport-dependent */
      },
      setInputs(next) {
        inputs = next;
        emit();
      },
      suspend() {
        /* nothing to release */
      },
      resume() {
        emit();
      },
      stop() {
        ctx = null;
      },
    };
  },
};

registerNativeIndicator(descriptor);

export const PDHPDL_TYPE = descriptor.type;
