/**
 * Pure layout DATA — no Vela imports, so the picker UI can use it without pulling the
 * 1.4 MB workspace chunk into the initial bundle.
 *
 * `cols` / `rows` are `fr` track weights; `areas` is a CSS `grid-template-areas` map.
 * The registration side (`layouts.ts`) turns these into Vela `LayoutRegistration`s.
 */

export interface LayoutDef {
  id: string;
  label: string;
  cols: number[];
  rows: number[];
  areas?: string[];
}

/** One big cell on the left, `n` smaller ones stacked to its right. */
function bigLeft(id: string, label: string, n: number, smallCols = 1): LayoutDef {
  const letters = 'abcdefgh';
  const smallRows = Math.ceil(n / smallCols);
  const areas: string[] = [];
  let used = 0;
  for (let r = 0; r < smallRows; r += 1) {
    const row = ['main'];
    for (let c = 0; c < smallCols; c += 1) row.push(used < n ? letters[used++]! : '.');
    areas.push(row.join(' '));
  }
  return { id, label, cols: [2, ...Array.from({ length: smallCols }, () => 1)], rows: Array.from({ length: smallRows }, () => 1), areas };
}

/** One big cell on the right, `n` smaller ones stacked to its left. */
function bigRight(id: string, label: string, n: number): LayoutDef {
  const letters = 'abcdefgh';
  return {
    id,
    label,
    cols: [1, 2],
    rows: Array.from({ length: n }, () => 1),
    areas: Array.from({ length: n }, (_, i) => `${letters[i]} main`),
  };
}

/** One big cell on top, `n` smaller ones in a row underneath. */
function bigTop(id: string, label: string, n: number): LayoutDef {
  const letters = 'abcdefgh';
  return {
    id,
    label,
    cols: Array.from({ length: n }, () => 1),
    rows: [2, 1],
    areas: [Array.from({ length: n }, () => 'main').join(' '), letters.slice(0, n).split('').join(' ')],
  };
}

/** One big cell at the bottom, `n` smaller ones in a row above. */
function bigBottom(id: string, label: string, n: number): LayoutDef {
  const letters = 'abcdefgh';
  return {
    id,
    label,
    cols: Array.from({ length: n }, () => 1),
    rows: [1, 2],
    areas: [letters.slice(0, n).split('').join(' '), Array.from({ length: n }, () => 'main').join(' ')],
  };
}

/** A uniform grid the picker's 4×4 canvas cannot reach. */
function uniform(id: string, label: string, cols: number, rows: number): LayoutDef {
  return { id, label, cols: Array.from({ length: cols }, () => 1), rows: Array.from({ length: rows }, () => 1) };
}

export const CUSTOM_LAYOUTS: LayoutDef[] = [
  bigLeft('3-main-left', '3 左大右双', 2),
  bigRight('3-main-right', '3 左双右大', 2),
  bigTop('3-main-top', '3 上大下双', 2),

  bigLeft('4-main-left', '4 左大右三', 3),
  bigRight('4-main-right', '4 左三右大', 3),
  bigTop('4-main-top', '4 上大下三', 3),
  bigBottom('4-main-bottom', '4 上三下大', 3),

  bigLeft('5-main-left', '5 左大右四', 4, 2),
  bigTop('5-main-top', '5 上大下四', 4),
  { id: '5-mixed', label: '5 上二下三', cols: [1, 1, 1], rows: [1, 1], areas: ['a a b', 'c d e'] },

  uniform('10', '10 格 5×2', 5, 2),
  uniform('14', '14 格 7×2', 7, 2),
];

/** Which layouts to group under which heading in the picker. */
export const LAYOUT_GROUPS: Array<{ title: string; ids: string[] }> = [
  { title: '3 格', ids: ['3-main-left', '3-main-right', '3-main-top'] },
  { title: '4 格', ids: ['4-main-left', '4-main-right', '4-main-top', '4-main-bottom'] },
  { title: '5 格', ids: ['5-main-left', '5-main-top', '5-mixed'] },
  { title: '更多', ids: ['10', '14'] },
];

/** Slot rectangles in 0..1 space — drives the SVG previews. */
export function slotRects(def: Pick<LayoutDef, 'cols' | 'rows' | 'areas'>): Array<{ x: number; y: number; w: number; h: number }> {
  const totalW = def.cols.reduce((a, b) => a + b, 0) || 1;
  const totalH = def.rows.reduce((a, b) => a + b, 0) || 1;

  const colX: number[] = [];
  let acc = 0;
  for (const c of def.cols) {
    colX.push(acc / totalW);
    acc += c;
  }
  const rowY: number[] = [];
  acc = 0;
  for (const r of def.rows) {
    rowY.push(acc / totalH);
    acc += r;
  }

  if (!def.areas) {
    const out: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (let r = 0; r < def.rows.length; r += 1) {
      for (let c = 0; c < def.cols.length; c += 1) {
        out.push({ x: colX[c]!, y: rowY[r]!, w: def.cols[c]! / totalW, h: def.rows[r]! / totalH });
      }
    }
    return out;
  }

  const bounds = new Map<string, { r0: number; r1: number; c0: number; c1: number }>();
  def.areas.forEach((row, r) => {
    row.split(/\s+/).forEach((name, c) => {
      if (name === '.' || !name) return;
      const b = bounds.get(name) ?? { r0: r, r1: r, c0: c, c1: c };
      b.r0 = Math.min(b.r0, r);
      b.r1 = Math.max(b.r1, r);
      b.c0 = Math.min(b.c0, c);
      b.c1 = Math.max(b.c1, c);
      bounds.set(name, b);
    });
  });

  return [...bounds.values()].map((b) => ({
    x: colX[b.c0]!,
    y: rowY[b.r0]!,
    w: colX[b.c1]! + def.cols[b.c1]! / totalW - colX[b.c0]!,
    h: rowY[b.r1]! + def.rows[b.r1]! / totalH - rowY[b.r0]!,
  }));
}

/** `g<rows>x<cols>` — Vela synthesizes any uniform grid up to 4×4 from this id. */
export function gridId(rows: number, cols: number): string {
  return `g${rows}x${cols}`;
}
