export interface NoteSection { id: string; title: string; checked: boolean; body: string }
export interface NotebookValue { body: string; tags: string[]; sections: NoteSection[] }
export interface NotebookTemplate { id: string | number; name: string; sections: NoteSection[]; uses: number; last_used: number }
export interface NotebookPhrase { id: string | number; text: string; uses: number; last_used: number }
export interface NotebookLibrary {
  templates: NotebookTemplate[];
  phrases: NotebookPhrase[];
  chapters: Array<{ title: string; uses: number; last_used: number }>;
}

export const SYSTEM_PHRASES = ['扫了低点', '扫了高点', '拿了 IDM', 'FVG 被缓解', '触及 POI', '出现 Flip', '突破后回踩', '等待确认'];
export const STARTER_CHAPTERS = ['交易前的判断', '入场依据', '持仓过程', '结果与改进'];

export function newSection(title = ''): NoteSection {
  return { id: crypto.randomUUID(), title, checked: false, body: '' };
}

/** Applying a reusable structure cannot overwrite this trade's text, checks or ids. */
export function appendTemplate(current: NoteSection[], template: Pick<NotebookTemplate, 'sections'>): NoteSection[] {
  return [...current, ...template.sections.slice(0, Math.max(0, 30 - current.length)).map(section => newSection(section.title))];
}

/** A template is structure, not a copy of somebody's trade-specific conclusions. */
export function templateStructure(sections: NoteSection[]): NoteSection[] {
  return sections.filter(section => section.title.trim()).map(section => ({ ...section, title: section.title.trim(), checked: false, body: '' }));
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
