import { snapTradePrice, type TradePriceField } from '../trade/chartOrders';

export interface OrderLevel {
  ticket: string; side: string; entry: number; sl?: number | null; tp?: number | null; volume?: number;
  draft?: boolean; editable?: boolean; digits?: number; step?: number;
}
export const transientOrderLine = (row: any): boolean => /^同频(?:持仓 #|待下单 )/.test(row?.text?.value ?? '');
const fields: TradePriceField[] = ['entry', 'sl', 'tp'];
const names = { entry: '入场', sl: '止损', tp: '止盈' };
function label(level: OrderLevel, field: TradePriceField) {
  return `${level.draft ? '同频待下单' : '同频持仓 #' + level.ticket} ${names[field]} `;
}

/** Native updates also emit edited events. Keep trading callbacks exclusive to changed user prices. */
export class OrderLevels {
  private syncing = 0;
  private sent = new Map<string, { price: number; at: number }>();
  constructor(private levels: () => OrderLevel[], private edited: (ticket: string, field: TradePriceField, price: number) => void, private blocked: () => boolean, private now = () => Date.now()) {}
  sync(cell: any, colors: { entry: string; sl: string; tp: string }, visible = true) {
    const api = cell?.chart?.drawings;
    if (!api) return;
    this.syncing++;
    try {
      const rows = [...api.all()];
      const kept = new Set<string>();
      for (const level of this.levels()) for (const field of fields) {
        const price = level[field];
        if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;
        const prefix = label(level, field);
        const existing = rows.find((row: any) => !kept.has(row.id) && row.text?.value?.startsWith(prefix));
        const init = { anchors: [{ time: this.now(), price }],
          style: { lineColor: colors[field], lineWidth: 1, lineStyle: field === 'entry' && !level.draft ? 'solid' : 'dashed' },
          text: { value: prefix + price.toFixed(level.digits ?? 2), size: 'small', bold: true, hAlign: 'left', vAlign: field === 'sl' ? 'top' : 'bottom', color: colors[field] }, zIndex: level.draft ? 2001 : 1995 };
        const drawing = existing ?? api.add('hline', init);
        if (!drawing) continue;
        if (existing) api.update(drawing.id, init);
        kept.add(drawing.id);
        api.lock(drawing.id, !level.editable || (!level.draft && field === 'entry') || !visible);
        api.show(drawing.id, visible);
      }
      for (const row of rows) if (transientOrderLine(row) && !kept.has(row.id)) api.remove(row.id);
    } finally { this.syncing--; }
  }
  edit(cell: any, id: string) {
    if (this.syncing || this.blocked()) return;
    const row = cell.chart.drawings.all().find((item: any) => item.id === id);
    if (!transientOrderLine(row)) return;
    for (const level of this.levels()) for (const field of fields) {
      if (!row.text.value.startsWith(label(level, field)) || !level.editable || (!level.draft && field === 'entry')) continue;
      const raw = row.anchors?.[0]?.price;
      if (!Number.isFinite(raw) || raw <= 0) return;
      const price = snapTradePrice(raw, level.step ?? .01, level.digits ?? 2);
      if (Math.abs(price - Number(level[field] ?? 0)) < 1e-8) return;
      const key = `${level.ticket}|${field}`;
      const last = this.sent.get(key);
      if (last?.price === price && this.now() - last.at < 1000) return;
      this.sent.set(key, { price, at: this.now() });
      this.edited(level.ticket, field, price);
      return;
    }
  }
}
