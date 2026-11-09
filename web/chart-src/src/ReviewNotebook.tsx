import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import chapterPresets from './publicChapterPresets.json';
import {
  appendChecklist, appendPhrase, appendTemplate, checklistProgress, frequentFirst, MAX_SECTIONS, moveSection,
  newSection, summarizeNote, SYSTEM_PHRASES, templateStructure, VERDICTS,
  type NotebookLibrary, type NotebookValue, type NoteSection, type PublicChapter, type Verdict,
} from './notebookModel';
export type { NotebookValue, NoteSection } from './notebookModel';

interface DrawingCandidate { id: string; type: string; text: string; timeframe: string; anchorMs: number | null; snapshot: unknown }
interface EvidenceApi {
  list(): DrawingCandidate[];
  select(ids: string[] | null): void;
  goTo(timeframe: string, anchorMs: number | null): void;
}

interface Props {
  value: NotebookValue;
  onChange(value: NotebookValue): void;
  readOnly: boolean;
  onError?(message: string): void;
  evidence?: EvidenceApi;
}
const EMPTY_LIBRARY: NotebookLibrary = { templates: [], phrases: [], chapters: [] };
const PUBLIC_PRESETS: PublicChapter[] = chapterPresets.map(item => ({ ...item, users: 0, uses: 0, system: true }));

interface Stats {
  notes: number;
  verdicts: Record<string, number>;
  skipped: Array<{ title: string; total: number; checked: number; rate: number }>;
  titles: Array<{ title: string; total: number; checked: number; rate: number }>;
}

type Block =
  | { kind: 'group'; name: string; members: Array<{ section: NoteSection; index: number }> }
  | { kind: 'loose'; section: NoteSection; index: number };

/** 按出现顺序把条目聚成「分组卡片」；没有分组的仍是自由条目。 */
function blocks(sections: NoteSection[]): Block[] {
  const out: Block[] = [];
  sections.forEach((section, index) => {
    const name = (section.group || '').trim();
    if (!name) { out.push({ kind: 'loose', section, index }); return; }
    const last = out[out.length - 1];
    if (last && last.kind === 'group' && last.name === name) last.members.push({ section, index });
    else out.push({ kind: 'group', name, members: [{ section, index }] });
  });
  return out;
}

const verdictLabel = (verdict?: Verdict | null) => VERDICTS.find(v => v.id === verdict)?.label ?? '';

/** User-owned chapters and reusable structures; no trading-system taxonomy. */
export function ReviewNotebook({ value, onChange, readOnly, onError, evidence }: Props) {
  const [library, setLibrary] = useState<NotebookLibrary>(EMPTY_LIBRARY);
  const [quickOpen, setQuickOpen] = useState(false);
  const [libraryExpanded, setLibraryExpanded] = useState(false);
  const [chapterDraft, setChapterDraft] = useState('');
  const [pickedChapter, setPickedChapter] = useState<PublicChapter | null>(null);
  const quickDialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string | null>(value.sections[0]?.id ?? null);
  const [templateName, setTemplateName] = useState('');
  const [templatePhrases, setTemplatePhrases] = useState<string[]>([]);
  const [phraseDraft, setPhraseDraft] = useState('');
  const [phraseText, setPhraseText] = useState('');
  const [editingTemplate, setEditingTemplate] = useState<string | number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!readOnly);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [removed, setRemoved] = useState<{ section: NoteSection; index: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeTemplate, setActiveTemplate] = useState<{ name: string; phrases: string[] } | null>(null);
  const [selection, setSelection] = useState<{ id: string; text: string } | null>(null);
  const [cloud, setCloud] = useState<PublicChapter[] | null>(null);
  const [cloudQuery, setCloudQuery] = useState('');
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudError, setCloudError] = useState('');
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DrawingCandidate[]>([]);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [copied, setCopied] = useState(false);
  const [inspirationOpen, setInspirationOpen] = useState(false);
  const areas = useRef(new Map<string, HTMLTextAreaElement>());
  const carets = useRef(new Map<string, { start: number; end: number }>());
  const lastFocused = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    if (!readOnly) {
      setLoading(true);
      void api<NotebookLibrary>('/api/journal/library').then(result => {
        if (mounted.current) setLibrary({ ...EMPTY_LIBRARY, ...result });
      }).catch(failure => {
        if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
      }).finally(() => { if (mounted.current) setLoading(false); });
    }
    return () => { mounted.current = false; };
  }, [readOnly]);
  useEffect(() => {
    const onSelectionChange = () => {
      const node = document.activeElement as HTMLTextAreaElement | null;
      if (!node || node.tagName !== 'TEXTAREA') return;
      for (const [id, area] of areas.current) {
        if (area !== node) continue;
        const start = node.selectionStart ?? 0;
        const end = node.selectionEnd ?? start;
        carets.current.set(id, { start, end });
        setSelection(node.value.slice(start, end).trim() ? { id, text: node.value.slice(start, end) } : null);
        return;
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  const active = value.sections.find(section => section.id === selected) ?? value.sections[0];
  const progress = checklistProgress(value.sections);
  const closeQuickAdd = () => {
    quickDialog.current?.close();
    setQuickOpen(false);
  };
  const updateSection = (id: string, patch: Partial<NoteSection>) => {
    onChange({ ...value, sections: value.sections.map(section => section.id === id ? { ...section, ...patch } : section) });
  };
  const addChapter = (title = '', group: string | null = null) => {
    if (value.sections.length >= MAX_SECTIONS) return;
    const section = newSection(title, group);
    onChange({ ...value, sections: [...value.sections, section] });
    setSelected(section.id);
  };
  const toggleGroup = (name: string) => setCollapsed(previous => {
    const next = new Set(previous);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await action(); }
    catch (failure) {
      const text = failure instanceof Error ? failure.message : String(failure);
      if (mounted.current) setError(text);
      onError?.(text);
    } finally { if (mounted.current) setBusy(false); }
  };
  const refresh = async () => {
    const result = await api<NotebookLibrary>('/api/journal/library');
    if (mounted.current) setLibrary({ ...EMPTY_LIBRARY, ...result });
  };
  const rememberCaret = (section: NoteSection, area: HTMLTextAreaElement | null) => {
    if (!area) return;
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? start;
    carets.current.set(section.id, { start, end });
    const picked = area.value.slice(start, end);
    setSelection(picked.trim() ? { id: section.id, text: picked } : null);
  };
  /** 插入到光标处；没有光标信息时退回追加到结尾。 */
  const insertPhrase = (text: string, id?: string | number) => {
    const goalId = lastFocused.current ?? active?.id ?? null;
    const goal = value.sections.find(section => section.id === goalId) ?? active;
    if (!goal) { setError('先添加一个条目，再插入常用语。'); return; }
    const area = areas.current.get(goal.id);
    const caret = carets.current.get(goal.id);
    let body: string;
    let position: number;
    if (area && caret) {
      body = `${goal.body.slice(0, caret.start)}${text}${goal.body.slice(caret.end)}`;
      position = caret.start + text.length;
    } else {
      body = appendPhrase(goal.body, text);
      position = body.length;
    }
    if (body.length > 3000) { setError('这一条已接近 3000 字，无法继续插入。'); return; }
    updateSection(goal.id, { body });
    closeQuickAdd();
    carets.current.set(goal.id, { start: position, end: position });
    setError(''); setMessage(`已插入「${goal.title.trim() || '未命名条目'}」`);
    window.requestAnimationFrame(() => {
      const node = areas.current.get(goal.id);
      if (!node) return;
      node.focus();
      node.setSelectionRange(position, position);
    });
    if (id != null) void api('/api/journal/library/use', { phrase_id: id }).then(refresh).catch(() => {});
  };
  const savePhrase = (text: string, pinned = false) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.length > 500) { setError('常用语最多 500 字。'); return; }
    void run(async () => {
      await api('/api/journal/phrases', { text: trimmed, pinned });
      await refresh(); setPhraseText(''); setMessage('已保存到我的常用语');
    });
  };
  const togglePin = (phrase: { id: string | number; pinned?: boolean }) => void run(async () => {
    await api('/api/journal/phrases/pin', { id: phrase.id, pinned: !phrase.pinned });
    await refresh();
  });
  const loadCloud = async () => {
    setCloudLoading(true);
    setCloudError('');
    try {
      const result = await api<{ chapters: PublicChapter[] }>('/api/journal/chapters?limit=60', undefined, { signal: AbortSignal.timeout(8000) });
      if (mounted.current) {
        const titles = new Set(result.chapters.map(item => item.title));
        setCloud([...result.chapters, ...PUBLIC_PRESETS.filter(item => !titles.has(item.title))]);
      }
    } catch {
      if (mounted.current) setCloudError('暂时无法读取灵感，点击重试。');
    } finally {
      if (mounted.current) setCloudLoading(false);
    }
  };
  useEffect(() => {
    if (quickOpen && !quickDialog.current?.open) quickDialog.current?.showModal();
  }, [quickOpen]);
  const openQuickAdd = () => {
    if (cloud === null && !cloudLoading) void loadCloud();
    setLibraryExpanded(false);
    setInspirationOpen(false);
    setPickedChapter(null);
    setCloudQuery('');
    setChapterDraft('');
    setError('');
    setMessage('');
    setQuickOpen(true);
  };
  const addFromCloud = (title: string, group?: string | null) => {
    addChapter(title, group);
    closeQuickAdd();
  };

  const openSummary = () => {
    setSummaryOpen(true);
    setCopied(false);
    if (!readOnly) void api<Stats>('/api/journal/stats').then(setStats).catch(() => setStats(null));
  };
  const summaryText = summarizeNote(value);
  const CLOUD_INKS = ['var(--text)', 'var(--accent-ink)', 'var(--good-ink)', 'var(--warn-ink)', 'var(--bad-ink)'];
  const inkOf = (title: string) => {
    let sum = 0;
    for (const char of title) sum += char.codePointAt(0) ?? 0;
    return CLOUD_INKS[sum % CLOUD_INKS.length];
  };
  const keyword = cloudQuery.trim().toLocaleLowerCase();
  const availableCloud = cloud ?? PUBLIC_PRESETS;
  const cloudRows = availableCloud.filter(item => item.title.toLocaleLowerCase().includes(keyword));
  const chapterExists = (title: string) => value.sections.some(section => section.title.trim() === title);
  const full = value.sections.length >= MAX_SECTIONS;
  const renderCloud = (rows: Array<{ title: string; uses: number; group?: string | null; users?: number; weight?: number; favorite?: boolean }>, publicCloud: boolean) => {
    const maxWeight = Math.max(1, ...rows.map(item => item.users ?? item.uses));
    return <div className="notebook-cloud">
      {rows.map(item => {
        const size = item.weight ? 14 + item.weight * 2 : 14 + 13 * Math.sqrt((item.users ?? item.uses) / maxWeight);
        const chosen = publicCloud && pickedChapter?.title === item.title;
        return <button
          type="button"
          key={item.title}
          className={`notebook-cloud-item${chosen ? ' is-picked' : ''}`}
          style={{ fontSize: `${size}px`, color: inkOf(item.title) }}
          aria-pressed={publicCloud ? chosen : undefined}
          title={item.group ? `分组：${item.group}` : undefined}
          disabled={!publicCloud && (full || chapterExists(item.title))}
          onClick={() => {
            if (!publicCloud) { addFromCloud(item.title, item.group); return; }
            setPickedChapter(availableCloud.find(chapter => chapter.title === item.title) ?? null);
          }}
        >{item.favorite && <small aria-hidden="true">★</small>}{item.title}</button>;
      })}
    </div>;
  };
  const circles = '①②③④⑤⑥⑦⑧⑨⑩';
  const openEvidencePicker = (id: string) => {
    setPickerFor(id);
    setCandidates(evidence?.list() ?? []);
  };
  const addEvidence = (section: NoteSection, candidate: DrawingCandidate) => {
    const snapshot = candidate.snapshot && typeof candidate.snapshot === 'object' ? candidate.snapshot as Record<string, unknown> : null;
    const item = {
      id: crypto.randomUUID(),
      caption: (candidate.text || candidate.type || '图形证据').slice(0, 200),
      drawing_id: candidate.id,
      timeframe: candidate.timeframe,
      anchor_ms: candidate.anchorMs,
      snapshot,
    };
    updateSection(section.id, { evidence: [...(section.evidence ?? []), item].slice(0, 10) });
    setPickerFor(null);
    setMessage('已关联图表证据，悬停可高亮原图。');
  };
  const applyTemplate = (template: { id: string | number; name: string; sections: NoteSection[]; phrases?: string[] }) => {
    if (!template.sections.length || value.sections.length + template.sections.length > MAX_SECTIONS) return;
    const sections = appendTemplate(value.sections, template);
    onChange({ ...value, sections });
    setSelected(sections[value.sections.length]?.id ?? null);
    setActiveTemplate({ name: template.name, phrases: template.phrases ?? [] });
    closeQuickAdd();
    setMessage(`已添加「${template.name}」的条目，原有内容已保留。`);
    void api('/api/journal/library/use', { template_id: template.id }).then(refresh).catch(() => {});
  };

  const renderSection = (section: NoteSection, index: number) => {
    const verdict = section.verdict ?? null;
    const picked = selection?.id === section.id ? selection.text : '';
    return <section key={section.id} className={`notebook-section${section.checked ? ' is-checked' : ''}${active?.id === section.id ? ' is-selected' : ''}`}>
      <div className="notebook-section-head">
        <label className="notebook-check" title="已检查，表示这一项已经看过，不代表交易条件成立">
          <input type="checkbox" checked={section.checked} disabled={readOnly} aria-label={`已检查：${section.title || `第 ${index + 1} 条`}`} onChange={event => updateSection(section.id, { checked: event.target.checked })}/>
          <span className="sr-only">已检查</span>
        </label>
        {readOnly ? <h4>{section.title || `第 ${index + 1} 条`}</h4> : <input className="notebook-section-title" aria-label={`第 ${index + 1} 条标题`} maxLength={80} value={section.title} placeholder="给这一条起个名字" onFocus={() => setSelected(section.id)} onChange={event => updateSection(section.id, { title: event.target.value })}/>}
        {!readOnly && <div className="notebook-section-actions">
          <button type="button" disabled={index === 0} aria-label={`上移第 ${index + 1} 条`} title="上移" onClick={() => onChange({ ...value, sections: moveSection(value.sections, section.id, -1) })}>↑</button>
          <button type="button" disabled={index === value.sections.length - 1} aria-label={`下移第 ${index + 1} 条`} title="下移" onClick={() => onChange({ ...value, sections: moveSection(value.sections, section.id, 1) })}>↓</button>
          <button type="button" aria-label={`移除第 ${index + 1} 条`} title="移除条目，可撤销" onClick={() => {
            setRemoved({ section, index }); onChange({ ...value, sections: value.sections.filter(row => row.id !== section.id) });
          }}>×</button>
        </div>}
      </div>
      {readOnly
        ? <div className="notebook-section-readonly">
          {!!verdict && <span className={`notebook-verdict is-${verdict}`}>{verdictLabel(verdict)}</span>}
          <p className="notebook-section-content">{section.body || '未填写内容'}</p>
          {!!section.evidence?.length && <div className="notebook-evidence-row">
            {section.evidence.map((item, order) => <span className="notebook-evidence" key={item.id}>
              <button type="button" title={item.caption} onMouseEnter={() => evidence?.select([item.drawing_id])} onMouseLeave={() => evidence?.select(null)} onClick={() => evidence?.goTo(item.timeframe, item.anchor_ms)}>{circles[order] ?? String(order + 1)}{item.caption}</button>
            </span>)}
          </div>}
        </div>
        : <>
          <div className="notebook-verdicts" role="group" aria-label={`${section.title || `第 ${index + 1} 条`}的结论`}>
            <span className="notebook-verdicts-label">结论</span>
            {VERDICTS.map(choice => <button
              key={choice.id}
              type="button"
              aria-pressed={verdict === choice.id}
              className={`notebook-verdict-btn${verdict === choice.id ? ` is-${choice.id}` : ''}`}
              onClick={() => updateSection(section.id, { verdict: verdict === choice.id ? null : choice.id, checked: true })}
            >{choice.label}</button>)}
          </div>
          <textarea
            ref={node => { if (node) areas.current.set(section.id, node); else areas.current.delete(section.id); }}
            aria-label={`${section.title || `第 ${index + 1} 条`}内容`}
            value={section.body}
            maxLength={3000}
            placeholder="写下判断、依据或事后发现……"
            onFocus={() => { setSelected(section.id); lastFocused.current = section.id; }}
            onSelect={event => rememberCaret(section, event.currentTarget)}
            onKeyUp={event => rememberCaret(section, event.currentTarget)}
            onMouseUp={event => rememberCaret(section, event.currentTarget)}
            onChange={event => updateSection(section.id, { body: event.target.value })}
          />
          {(section.evidence?.length || !readOnly) ? <div className="notebook-evidence-row">
            {(section.evidence ?? []).map((item, order) => <span className="notebook-evidence" key={item.id}>
              <button
                type="button"
                title={`${item.caption}（${item.timeframe || '当前周期'}）`}
                onMouseEnter={() => evidence?.select([item.drawing_id])}
                onMouseLeave={() => evidence?.select(null)}
                onFocus={() => evidence?.select([item.drawing_id])}
                onBlur={() => evidence?.select(null)}
                onClick={() => evidence?.goTo(item.timeframe, item.anchor_ms)}
              >{circles[order] ?? String(order + 1)}{item.caption}</button>
              {!readOnly && <button type="button" className="notebook-evidence-remove" aria-label={`移除证据 ${item.caption}`} onClick={() => updateSection(section.id, { evidence: (section.evidence ?? []).filter(row => row.id !== item.id) })}>×</button>}
            </span>)}
            {!readOnly && <button type="button" className="link notebook-evidence-add" disabled={!evidence} title={evidence ? '从当前图的画线里挑一个' : '图表还没准备好'} onClick={() => openEvidencePicker(section.id)}>＋ 图表证据</button>}
          </div> : null}
          {!readOnly && pickerFor === section.id && <div className="notebook-evidence-picker">
            <div className="notebook-evidence-picker-head"><span>当前图的画线</span><button type="button" className="link" onClick={() => setPickerFor(null)}>取消</button></div>
            {candidates.length ? candidates.map(candidate => <button type="button" key={candidate.id} className="notebook-evidence-candidate" onClick={() => addEvidence(section, candidate)}>
              <span>{candidate.text || candidate.type || '图形'}</span>
              <small>{candidate.type}{candidate.timeframe ? ` · ${candidate.timeframe}` : ''}</small>
            </button>) : <p className="notebook-library-hint">当前图还没有带说明的画线。先在图上画一个图形并写上注释。</p>}
          </div>}

          <div className="notebook-section-foot">
            <button type="button" className="link" onClick={() => {
              setSelected(section.id);
              lastFocused.current = section.id;
              openQuickAdd();
              setLibraryExpanded(true);
            }}>插入常用语</button>
            <div className="notebook-foot-right">
              <button type="button" className="link" disabled={!picked.trim() || busy} title="把选中文字存成常用语" onClick={() => savePhrase(picked)}>存选中为常用语</button>
              <button type="button" className="link" title="最多保存 500 字" disabled={!section.body.trim() || section.body.trim().length > 500 || busy} onClick={() => savePhrase(section.body)}>存为常用语</button>
            </div>
          </div>
        </>}
    </section>;
  };

  const templateChips = activeTemplate?.phrases ?? [];
  return <div className={`review-notebook${readOnly ? ' is-readonly' : ''}`}>
    <div className="notebook-heading">
      <strong>我的复盘清单</strong>
      <span>{progress.total ? `完成 ${progress.done}/${progress.total}` : value.sections.length ? `已检查 ${value.sections.filter(s => s.checked).length}/${value.sections.length}` : '按自己的习惯记录'}</span>
    </div>
    {activeTemplate && <div className="notebook-active-template"><span>模板：{activeTemplate.name}</span><button type="button" onClick={() => setActiveTemplate(null)}>清除</button></div>}
    {!readOnly && <>
      <div className="notebook-toolbar">
        <button type="button" aria-haspopup="dialog" onClick={openQuickAdd}>＋ 快捷添加</button>
        <button type="button" aria-expanded={summaryOpen} onClick={() => (summaryOpen ? setSummaryOpen(false) : openSummary())}>复盘摘要</button>
      </div>
    </>}

    <div className="notebook-blocks">
      {blocks(value.sections).map(block => {
        if (block.kind === 'loose') return renderSection(block.section, block.index);
        const isCollapsed = collapsed.has(block.name);
        const checked = block.members.filter(({ section }) => section.checked).length;
        return <div className="notebook-group" key={`${block.name}:${block.members[0]!.section.id}`}>
          <div className="notebook-group-head">
            <button type="button" className="notebook-group-toggle" aria-expanded={!isCollapsed} title={isCollapsed ? '展开' : '收起'} onClick={() => toggleGroup(block.name)}>
              <span className="notebook-group-caret" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
              <span className="notebook-group-name">{block.name}</span>
            </button>
            <span className="notebook-group-count">{checked}/{block.members.length}</span>
            {!readOnly && <button type="button" className="notebook-group-add" title={`在「${block.name}」里加一项`} disabled={value.sections.length >= MAX_SECTIONS} onClick={() => addChapter('', block.name)}>＋</button>}
          </div>
          {!isCollapsed && <div className="notebook-group-items">{block.members.map(({ section, index }) => renderSection(section, index))}</div>}
        </div>;
      })}
    </div>
    {!readOnly && removed && <div className="notebook-undo"><span>已移除「{removed.section.title || '未命名条目'}」</span><button type="button" className="link" disabled={value.sections.length >= MAX_SECTIONS} onClick={() => {
      const sections = [...value.sections]; sections.splice(Math.min(removed.index, sections.length), 0, removed.section);
      onChange({ ...value, sections }); setRemoved(null);
    }}>撤销移除</button></div>}

    {!readOnly && quickOpen && <dialog ref={quickDialog} className="notebook-quick-dialog" aria-labelledby="sn-quick-title"
      onClose={() => setQuickOpen(false)} onClick={event => {
        if (event.target !== event.currentTarget) return;
        const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect();
        if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) closeQuickAdd();
      }}>
      <div className="notebook-library-head">
        <strong id="sn-quick-title">快捷添加</strong>
        <button type="button" aria-label="关闭快捷添加" onClick={closeQuickAdd}>×</button>
      </div>
      <section className="notebook-quick-cloud" aria-label="我的词云">
        <h5>我的词云</h5>
        {library.chapters.length ? renderCloud(library.chapters, false) : <p className="notebook-library-hint">
          {loading ? '正在读取个人词云…' : '常用条目和收藏会出现在这里。'}
        </p>}
      </section>
      <form className="notebook-library-form notebook-chapter-form" onSubmit={event => {
        event.preventDefault();
        const title = chapterDraft.trim();
        if (title && !full && !chapterExists(title)) addFromCloud(title);
      }}>
        <input autoFocus={!libraryExpanded} aria-label="条目名称" maxLength={80} placeholder="输入条目名称" value={chapterDraft} onChange={event => setChapterDraft(event.target.value)}/>
        <button type="submit" disabled={full || !chapterDraft.trim() || chapterExists(chapterDraft.trim())}>添加</button>
        <button type="button" aria-expanded={inspirationOpen} aria-controls="sn-public-cloud" onClick={() => {
          setInspirationOpen(!inspirationOpen);
        }}>灵感</button>
      </form>
      {full && <p className="notebook-library-hint">这笔复盘已达 {MAX_SECTIONS} 个条目。</p>}
      {inspirationOpen && <section className="notebook-quick-cloud notebook-public-cloud" id="sn-public-cloud" aria-label="公共词云">
        <h5>公共词云</h5>
        <div className="notebook-library-form">
          <input aria-label="筛选灵感条目" maxLength={80} placeholder="筛选条目名" value={cloudQuery} onChange={event => { setCloudQuery(event.target.value); setPickedChapter(null); }}/>
          {cloudError && <button type="button" disabled={cloudLoading} onClick={() => void loadCloud()}>重试</button>}
        </div>
        {cloudRows.length ? renderCloud(cloudRows, true) : <p className="notebook-library-hint">
          {cloudLoading ? '正在查找其他公共条目…' : '没有匹配的条目。'}
        </p>}
        {pickedChapter && <div className="notebook-picked-chapter">
          <strong>{pickedChapter.title}</strong>
          <button type="button" disabled={busy || loading || library.chapters.some(row => row.title === pickedChapter.title && row.favorite)} onClick={() => void run(async () => {
            await api('/api/journal/chapters/favorite', { title: pickedChapter.title, group: pickedChapter.group });
            await refresh();
            if (mounted.current) setMessage('已收藏到我的词云');
          })}>{library.chapters.some(row => row.title === pickedChapter.title && row.favorite) ? '已收藏' : '收藏'}</button>
          <button type="button" disabled={full || chapterExists(pickedChapter.title)} onClick={() => addFromCloud(pickedChapter.title, pickedChapter.group)}>添加到复盘</button>
        </div>}
      </section>}
      {message && <p className="notebook-feedback" role="status">{message}</p>}
      {error && <p className="notebook-error" role="alert">{error}</p>}
      <details className="notebook-library" open={libraryExpanded} onToggle={event => setLibraryExpanded(event.currentTarget.open)}>
      <summary>模板与常用语</summary>
      <h5>条目组合</h5>
      {progress.total === 0 && <button type="button" className="tool-btn" disabled={full} onClick={() => {
        const next = appendChecklist(value.sections);
        onChange({ ...value, sections: next });
        setSelected(next[value.sections.length]?.id ?? null);
        closeQuickAdd();
      }}>添加通用清单</button>}
      {frequentFirst(library.templates).map(template => <div className="notebook-template" key={template.id}><div className="notebook-library-item">
        <button type="button" title={`添加 ${template.sections.length} 个条目；保留已有内容`} disabled={!template.sections.length || value.sections.length + template.sections.length > MAX_SECTIONS || busy} onClick={() => applyTemplate(template)}><span>{template.pinned ? '★ ' : ''}{template.name}</span><small>{template.sections.length} 条{(template.phrases ?? []).length ? ` · ${(template.phrases ?? []).length} 条用语` : ''} · 用过 {template.uses} 次</small></button>
        <button type="button" className="notebook-library-remove" aria-pressed={Boolean(template.pinned)} title={template.pinned ? '取消固定' : '固定到前面'} aria-label={`固定模板 ${template.name}`} disabled={busy} onClick={() => void run(async () => {
          await api('/api/journal/templates/pin', { template_id: template.id, pinned: !template.pinned }); await refresh();
        })}>{template.pinned ? '★' : '☆'}</button>
        <button type="button" className="notebook-library-remove" aria-label={`编辑模板 ${template.name}`} disabled={busy} onClick={() => { setEditingTemplate(editingTemplate === template.id ? null : template.id); setEditingName(template.name); setTemplatePhrases([...(template.phrases ?? [])]); }}>编辑</button>
        <button type="button" className="notebook-library-remove" title="删除我的模板" aria-label={`删除模板 ${template.name}`} disabled={busy} onClick={() => void run(async () => {
          await api('/api/journal/library/remove', { template_id: template.id }); await refresh(); setMessage('模板已删除，当前笔记保留。');
        })}>×</button>
      </div>{editingTemplate === template.id && <div className="notebook-template-edit">
        <div className="notebook-library-form"><input aria-label={`模板 ${template.name} 的新名称`} maxLength={80} value={editingName} onChange={event => setEditingName(event.target.value)}/>
          <button type="button" disabled={busy || !editingName.trim()} onClick={() => void run(async () => {
            await api('/api/journal/templates', { id: template.id, name: editingName.trim(), sections: template.sections, phrases: templatePhrases });
            await refresh(); setEditingTemplate(null); setMessage('模板已更新');
          })}>保存</button></div>
        <div className="notebook-library-form"><input aria-label="模板常用语" maxLength={500} placeholder="给这个模板加一条常用语" value={phraseDraft} onChange={event => setPhraseDraft(event.target.value)}/>
          <button type="button" disabled={!phraseDraft.trim() || templatePhrases.length >= 20} onClick={() => { setTemplatePhrases([...templatePhrases, phraseDraft.trim()]); setPhraseDraft(''); }}>＋</button></div>
        {!!templatePhrases.length && <div className="notebook-phrases">{templatePhrases.map((text, index) => <span className="notebook-phrase" key={text}>
          <span>{text}</span><button type="button" className="notebook-phrase-remove" aria-label={`移除模板常用语 ${text}`} onClick={() => setTemplatePhrases(templatePhrases.filter((_, i) => i !== index))}>×</button>
        </span>)}</div>}
        <button type="button" className="link" disabled={busy || !templateStructure(value.sections).length || !editingName.trim()} onClick={() => void run(async () => {
          await api('/api/journal/templates', { id: template.id, name: editingName.trim(), sections: templateStructure(value.sections), phrases: templatePhrases });
          await refresh(); setEditingTemplate(null); setMessage('模板已更新为当前条目结构');
        })}>用当前条目更新此模板</button>
      </div>}</div>)}
      {!library.templates.length && <p className="notebook-library-hint">保存自己的条目组合，下次可以一键添加。</p>}
      <div className="notebook-library-form"><input aria-label="模板名称" maxLength={80} placeholder="给这套条目起个名字" value={templateName} onChange={event => setTemplateName(event.target.value)}/>
        <button type="button" disabled={busy || !templateName.trim() || !templateStructure(value.sections).length} onClick={() => void run(async () => {
          await api('/api/journal/templates', { name: templateName.trim(), sections: templateStructure(value.sections), phrases: templatePhrases });
          await refresh(); setTemplateName(''); setTemplatePhrases([]); setMessage('条目结构已存为模板，不含本次交易文字与勾选。');
        })}>保存组合</button></div>
      <p className="notebook-library-hint">只保存条目标题、分组和顺序，复盘内容仍属于这笔交易。</p>

      <h5>常用语</h5>
      <label className="notebook-target">插入到<select aria-label="常用语插入条目" value={active?.id ?? ''} disabled={!value.sections.length} onChange={event => setSelected(event.target.value)}>
        {!value.sections.length && <option value="">先添加一个条目</option>}
        {value.sections.map((section, index) => <option key={section.id} value={section.id}>{section.title || `第 ${index + 1} 条`}</option>)}
      </select></label>
      {!!templateChips.length && <><p className="notebook-library-hint">当前模板用语</p><div className="notebook-phrases" aria-label="当前模板用语">{templateChips.map(text => <button type="button" key={text} disabled={!active} onClick={() => insertPhrase(text)}>{text}</button>)}</div></>}
      {!!library.phrases.length && <div className="notebook-phrases" aria-label="我的常用语">{frequentFirst(library.phrases).map(phrase => <span className={`notebook-phrase${phrase.pinned ? ' is-pinned' : ''}`} key={phrase.id}>
        <button type="button" className="notebook-phrase-pin" aria-pressed={Boolean(phrase.pinned)} title={phrase.pinned ? '取消固定' : '固定到前面'} onClick={() => togglePin(phrase)}>{phrase.pinned ? '★' : '☆'}</button>
        <button type="button" disabled={!active} title={`用过 ${phrase.uses} 次`} onClick={() => insertPhrase(phrase.text, phrase.id)}>{phrase.text}</button>
        <button type="button" className="notebook-phrase-remove" aria-label={`删除常用语 ${phrase.text}`} disabled={busy} onClick={() => void run(async () => {
          await api('/api/journal/library/remove', { phrase_id: phrase.id }); await refresh();
        })}>×</button>
      </span>)}</div>}
      <p className="notebook-library-hint">系统词库</p>
      <div className="notebook-phrases" aria-label="系统常用语">{SYSTEM_PHRASES.map(text => <button type="button" key={text} disabled={!active} onClick={() => insertPhrase(text)}>{text}</button>)}</div>
      <div className="notebook-library-form"><input aria-label="新常用语" maxLength={500} placeholder="写一句自己的常用语" value={phraseText} onChange={event => setPhraseText(event.target.value)}/>
        <button type="button" disabled={busy || !phraseText.trim()} onClick={() => savePhrase(phraseText)}>保存</button></div>
      </details>
    </dialog>}

    {summaryOpen && <div className="notebook-summary">
      <div className="notebook-summary-head">
        <strong>复盘摘要</strong>
        <span>由清单生成，只读；改内容请改上面的清单。</span>
        <button type="button" className="link" onClick={() => {
          const text = summaryText;
          const done = () => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); };
          if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(done).catch(done);
          else done();
        }}>{copied ? '已复制' : '复制'}</button>
        <button type="button" className="link" onClick={() => setSummaryOpen(false)}>收起</button>
      </div>
      <pre className="notebook-summary-text">{summaryText}</pre>
      {stats && <div className="notebook-stats">
        <span>已复盘 {stats.notes} 笔</span>
        <span>符合 {stats.verdicts.yes ?? 0} · 不符合 {stats.verdicts.no ?? 0} · 不确定 {stats.verdicts.unclear ?? 0}</span>
        {!!stats.skipped.length && <span title="检查率最低的项">最常跳过：{stats.skipped.slice(0, 3).map(row => `${row.title}（${Math.round(row.rate * 100)}%）`).join('、')}</span>}
      </div>}
    </div>}

    <div className="notebook-free"><label htmlFor="note-body">自由笔记</label>{readOnly ? <p className="notebook-section-content">{value.body || '暂无自由笔记'}</p> : <textarea id="note-body" value={value.body} maxLength={10000} placeholder="其他想法可以写在这里，原来的笔记也保留在这里。" onChange={event => onChange({ ...value, body: event.target.value })}/>}</div>
    {!readOnly && !quickOpen && <><p className="notebook-feedback" role="status">{message}</p>{error && <p className="notebook-error" role="alert">{error}</p>}</>}
  </div>;
}
