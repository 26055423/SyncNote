import { registerWidgetAction, type WidgetContext } from '@luxalgo/vela';
import { Dialog, iconEl } from '@luxalgo/vela/ui';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';

type Row = ReturnType<VelaWorkspace['active']['libraryRows']>[number];
type Group = 'all' | 'recommended' | 'trend' | 'momentum' | 'volatility' | 'volume' | 'other' | 'onChart';
const GROUPS: Array<{ id: Group; label: string }> = [
  { id: 'all', label: '全部指标' }, { id: 'recommended', label: '同频精选' },
  { id: 'trend', label: '趋势' }, { id: 'momentum', label: '动量' },
  { id: 'volatility', label: '波动率' }, { id: 'volume', label: '成交量' },
  { id: 'other', label: '其他' }, { id: 'onChart', label: '当前图表' },
];
const pickers = new WeakMap<HTMLElement, { open(): void }>();

function groupFor(row: Row): Group {
  const id = row.nativeType ?? '';
  if (['bigwolf', 'hidden-ob', 'smc-pdhpdl', 'smc-structures'].includes(id)) return 'recommended';
  const text = [id, row.name, ...(row.aliases ?? [])].join(' ').toLowerCase();
  if (/volume|vwap|obv|money flow|chaikin|成交量|资金流|量价/.test(text)) return 'volume';
  if (/bollinger|atr\b|volatility|keltner|donchian|布林|真实波幅|波动/.test(text)) return 'volatility';
  if (/rsi|macd|stoch|momentum|cci\b|williams|roc\b|awesome|振荡|动量|相对强弱/.test(text)) return 'momentum';
  if (/average|\bema\b|\bsma\b|\bwma\b|supertrend|ichimoku|parabolic|均线|均值|趋势|一目/.test(text)) return 'trend';
  return 'other';
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// This public slot also routes the native keyboard shortcut and mobile menu.
// Registration must happen before constructing the workspace.
registerWidgetAction({
  id: 'indicators', target: 'topbar', align: 'left', label: '指标', icon: 'indicators',
  run(ctx: WidgetContext) { pickers.get(ctx.host)?.open(); },
});

/** Keep the native cell ledger: adds/removes retain Vela's undo, persistence and indicator pairing. */
export function attachIndicatorPicker(ws: VelaWorkspace): () => void {
  let group: Group = 'all';
  let query = '';
  let dialog: Dialog | null = null;
  let nav: HTMLElement;
  let list: HTMLElement;
  let resultLabel: HTMLElement;
  let feedback: HTMLElement;
  let search: HTMLInputElement;

  const render = () => {
    // Dialog.show() commits its open state asynchronously; render its content now.
    if (!dialog) return;
    const cell = ws.active;
    const library = cell.libraryRows().map((row, index) => ({ row, index }))
      .filter(({ row }) => row.nativeType !== 'bigwolf-macd');
    const onChart = cell.onChartRows().map((row, index) => ({ row, index }))
      .filter(({ row }) => row.nativeType !== 'bigwolf-macd');
    nav.replaceChildren();
    for (const item of GROUPS) {
      const count = item.id === 'onChart' ? onChart.length : item.id === 'all' ? library.length
        : library.filter(({ row }) => groupFor(row) === item.id).length;
      if (!count && item.id !== 'all' && item.id !== 'onChart') continue;
      const button = element('button', `indicator-library-tab${group === item.id ? ' active' : ''}`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(group === item.id));
      button.append(element('span', '', item.label), element('span', 'indicator-library-count', String(count)));
      button.onclick = () => { group = item.id; render(); };
      nav.append(button);
    }
    const rows = (group === 'onChart' ? onChart : library).filter(({ row }) => {
      if (group !== 'all' && group !== 'onChart' && groupFor(row) !== group) return false;
      return [row.name, row.nativeType, ...(row.aliases ?? [])].join(' ').toLowerCase().includes(query.toLowerCase().trim());
    });
    const label = GROUPS.find(item => item.id === group)!.label;
    resultLabel.textContent = `${label} · ${rows.length}`;
    list.replaceChildren();
    if (!rows.length) {
      list.append(element('div', 'indicator-library-empty', query ? '没有找到匹配的指标，试试英文名称或缩写。' : '当前图表还没有指标。'));
      return;
    }
    for (const { row, index } of rows) {
      const line = element('div', 'indicator-library-row');
      const action = element('button', 'indicator-library-add');
      action.type = 'button';
      action.append(iconEl(row.nativeType === 'bigwolf' || row.nativeType === 'hidden-ob' ? 'star' : 'indicators'));
      const words = element('span', 'indicator-library-name');
      words.append(element('strong', '', row.name));
      const alias = row.aliases?.find(name => name.toLowerCase() !== row.name.toLowerCase());
      if (alias) words.append(element('small', '', alias));
      action.append(words);
      if (group === 'onChart') {
        // The full-row target remains a label here; removal is an explicit separate action.
        action.disabled = true;
        const remove = element('button', 'indicator-library-remove', '移除');
        remove.type = 'button';
        remove.setAttribute('aria-label', `移除 ${row.name}`);
        remove.onclick = () => {
          try { cell.removeFromChart(index); feedback.textContent = `已移除 ${row.name}，可用撤销恢复。`; render(); }
          catch { feedback.textContent = '移除失败，请重试。'; }
        };
        line.append(action, remove);
      } else {
        action.title = `添加 ${row.name} 到当前图表`;
        action.append(element('span', 'indicator-library-plus', '+'));
        action.onclick = () => {
          try { cell.addFromLibrary(index); feedback.textContent = `已添加 ${row.name}，可继续选择或按 Esc 返回图表。`; render(); }
          catch { feedback.textContent = '添加失败，请重试。'; }
        };
        line.append(action);
      }
      list.append(line);
    }
  };

  const picker = {
    open() {
      if (!dialog) {
        const content = element('div', 'indicator-library');
        const searchRow = element('div', 'indicator-library-search');
        searchRow.append(iconEl('search'));
        search = element('input', '');
        search.type = 'search';
        search.placeholder = '搜索指标名称或缩写，例如 bigwolf、RSI、均线';
        search.setAttribute('aria-label', '搜索指标');
        search.oninput = () => { query = search.value; render(); };
        searchRow.append(search);
        const body = element('div', 'indicator-library-body');
        nav = element('nav', 'indicator-library-nav');
        nav.setAttribute('aria-label', '指标分类');
        const results = element('section', 'indicator-library-results');
        resultLabel = element('div', 'indicator-library-heading');
        list = element('div', 'indicator-library-list');
        results.append(resultLabel, list);
        body.append(nav, results);
        feedback = element('div', 'indicator-library-feedback', '点击指标添加到当前图表；「当前图表」中可移除，修改支持撤销。');
        feedback.setAttribute('role', 'status');
        content.append(searchRow, body);
        dialog = new Dialog({
          title: '指标', host: ws.root, content, footer: feedback, flush: true,
          className: 'tp-indicator-dialog', dimBackdrop: true, align: 'center',
          initialFocusEl: () => search,
        });
      }
      dialog.show();
      render();
    },
  };
  pickers.set(ws.root, picker);
  const offState = ws.on('state:changed', render);
  const offActive = ws.on('cell:active', render);
  return () => {
    pickers.delete(ws.root);
    offState(); offActive();
    dialog?.destroy();
  };
}
