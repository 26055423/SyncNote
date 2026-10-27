import { registerLayout } from '@luxalgo/vela/workspace';
import { CUSTOM_LAYOUTS, type LayoutDef } from './layoutDefs';

/**
 * Registers the asymmetric layouts with Vela's workspace.
 *
 * Vela's own picker can only *draw* rectangles, so every non-rectangular preset shows
 * up there as a text row. The app therefore ships its own icon picker
 * (`LayoutMenu.tsx`); this file only makes the layouts selectable by id.
 */

/** `cells` order = slot order; the area name binds each slot to its grid position. */
function cellsFor(def: LayoutDef): Array<{ id: string; area?: string }> {
  if (!def.areas) {
    const count = def.rows.length * def.cols.length;
    return Array.from({ length: count }, (_, i) => ({ id: `c${i + 1}` }));
  }
  const names: string[] = [];
  for (const row of def.areas) {
    for (const name of row.split(/\s+/)) {
      if (name && name !== '.' && !names.includes(name)) names.push(name);
    }
  }
  return names.map((area, i) => ({ id: `c${i + 1}`, area }));
}

for (const def of CUSTOM_LAYOUTS) {
  registerLayout({
    id: def.id,
    label: def.label,
    cols: def.cols,
    rows: def.rows,
    ...(def.areas ? { areas: def.areas } : {}),
    cells: cellsFor(def),
  });
}
