export type Verdict = 'yes' | 'no' | 'unclear' | 'na';

/** 挂在章节下的图表证据：图形编号 + 说明 + 关联时的快照。 */
export interface NoteEvidence {
  id: string;
  caption: string;
  drawing_id: string;
  timeframe: string;
  anchor_ms: number | null;
  snapshot?: Record<string, unknown> | null;
}

export interface NoteSection {
  id: string;
  title: string;
  checked: boolean;
  body: string;
  /** 分组名（检查项）。空 = 自由章节，不计入完成度。 */
  group?: string | null;
  /** 结论：勾选只表示看过，成立与否单独记。 */
  verdict?: Verdict | null;
  /** 图表证据卡。模板不保存证据。 */
  evidence?: NoteEvidence[];
}
export interface NotebookValue { body: string; tags: string[]; sections: NoteSection[] }
export interface NotebookTemplate { id: string | number; name: string; sections: NoteSection[]; phrases?: string[]; uses: number; last_used: number; pinned?: boolean }
export interface NotebookPhrase { id: string | number; text: string; uses: number; last_used: number; pinned?: boolean }
export interface NotebookLibrary {
  templates: NotebookTemplate[];
  phrases: NotebookPhrase[];
  chapters: Array<{ title: string; uses: number; last_used: number }>;
}

export interface PublicTemplate {
  id: string;
  name: string;
  summary: string;
  symbol: string;
  timeframe: string;
  version: number;
  uses: number;
  favorites: number;
  owner: string;
  mine: boolean;
  favorite: boolean;
  chapters: number;
  phrases: number;
}

export const SYSTEM_PHRASES = ['扫了低点', '扫了高点', '拿了 IDM', 'FVG 被缓解', '触及 POI', '出现 Flip', '突破后回踩', '等待确认'];
export const STARTER_CHAPTERS = ['交易前的判断', '入场依据', '持仓过程', '结果与改进'];

export const VERDICTS: Array<{ id: Verdict; label: string }> = [
  { id: 'yes', label: '符合' },
  { id: 'no', label: '不符合' },
  { id: 'unclear', label: '不确定' },
  { id: 'na', label: '不适用' },
];

/** 通用开单清单：只是起点，用户可随意改标题、删项、重排，不绑定任何流派。 */
export const DEFAULT_CHECKLIST: Array<{ group: string; items: string[] }> = [
  { group: '方向判断', items: ['大方向明确', '关键价位有依据'] },
  { group: '位置', items: ['到了计划中的位置', '溢价/折价区合适'] },
  { group: '确认', items: ['出现结构性确认，不是猜的', '流动性被清扫后回踩'] },
  { group: '执行', items: ['入场模型成立', '止损位置有依据'] },
  { group: '管理', items: ['仓位符合计划', '按计划减仓或移动止损'] },
  { group: '复盘', items: ['结果与预期一致或已解释', '下次只改一件事'] },
];

export const MAX_SECTIONS = 30;

export function newSection(title = '', group: string | null = null): NoteSection {
  return { id: crypto.randomUUID(), title, checked: false, body: '', group, verdict: null };
}

/** 整套通用清单：作为建议插入，不自动套用、不覆盖已有章节。 */
export function appendChecklist(current: NoteSection[]): NoteSection[] {
  const room = Math.max(0, MAX_SECTIONS - current.length);
  const added: NoteSection[] = [];
  for (const group of DEFAULT_CHECKLIST) {
    for (const title of group.items) {
      if (added.length >= room) break;
      added.push(newSection(title, group.group));
    }
  }
  return [...current, ...added];
}

/** Applying a reusable structure cannot overwrite this trade's text, checks or ids. */
export function appendTemplate(current: NoteSection[], template: Pick<NotebookTemplate, 'sections'>): NoteSection[] {
  return [
    ...current,
    ...template.sections.slice(0, Math.max(0, MAX_SECTIONS - current.length)).map(section => newSection(section.title, section.group ?? null)),
  ];
}

/** A template is structure, not a copy of somebody's trade-specific conclusions. */
export function templateStructure(sections: NoteSection[]): NoteSection[] {
  return sections
    .filter(section => section.title.trim())
    .map(section => ({ ...section, title: section.title.trim(), checked: false, body: '', verdict: null, evidence: [] }));
}

export function moveSection(sections: NoteSection[], id: string, direction: -1 | 1): NoteSection[] {
  const from = sections.findIndex(section => section.id === id), to = from + direction;
  if (from < 0 || to < 0 || to >= sections.length) return sections;
  const next = [...sections];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

export function appendPhrase(body: string, text: string): string {
  return body ? `${body}${/[\s，。；：、！？]$/.test(body) ? '' : '，'}${text}` : text;
}

/** Recommendations never reorder the actual notebook, only explicitly selected candidates. */
export function frequentFirst<T extends { uses: number; last_used: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.uses - a.uses || b.last_used - a.last_used);
}

/** 完成度：分母只算检查项，且排除「不适用」——自由章节不拉低完成度。 */
export function checklistProgress(sections: NoteSection[]): { done: number; total: number } {
  const items = sections.filter(section => section.group && section.verdict !== 'na');
  return { done: items.filter(section => section.checked).length, total: items.length };
}
