import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { PhrasePalette } from './PhrasePalette';
import {
  appendChecklist, insertAt, CHAPTERS, isChecklist, appendTemplate, checklistProgress, frequentFirst, MAX_SECTIONS, moveSection,
  newSection, summarizeNote, templateStructure, VERDICTS,
  type NotebookLibrary, type NotebookValue, type NoteSection, type Verdict,
} from './notebookModel';
export type { NotebookValue, NoteSection } from './notebookModel';

interface DrawingCandidate { id: string; type: string; text: string; timeframe: string; anchorMs: number | null; snapshot: unknown }
interface EvidenceApi {
  list(): DrawingCandidate[];
  select(ids: string[] | null): void;
  goTo(timeframe: string, anchorMs: number | null): void;
  insertText?(id: string, text: string): boolean;
}

interface Props {
  value: NotebookValue;
  onChange(value: NotebookValue): void;
  readOnly: boolean;
  onError?(message: string): void;
  evidence?: EvidenceApi;
}
const EMPTY_LIBRARY: NotebookLibrary = { templates: [], phrases: [], chapters: [] };

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
  /** 标题旁「＋」：不打开弹窗，直接手输条目名称。 */
  const [inlineOpen, setInlineOpen] = useState(false);
  /** 快捷添加里先多选，再一次性加入笔记。 */
  const [pick, setPick] = useState<string[]>([]);
  const [inlineTitle, setInlineTitle] = useState('');
  const quickDialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string | null>('body');
  const [templateName, setTemplateName] = useState('');
  const [templatePhrases, setTemplatePhrases] = useState<string[]>([]);
  const [phraseDraft, setPhraseDraft] = useState('');
  const [, setPhraseText] = useState('');
  const [editingTemplate, setEditingTemplate] = useState<string | number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [busy, setBusy] = useState(false);
  const [, setLoading] = useState(!readOnly);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [removed, setRemoved] = useState<{ section: NoteSection; index: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeTemplate, setActiveTemplate] = useState<{ name: string; phrases: string[] } | null>(null);
  const [selection, setSelection] = useState<{ id: string; text: string } | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DrawingCandidate[]>([]);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [copied, setCopied] = useState(false);
  const areas = useRef(new Map<string, HTMLTextAreaElement>());
  const carets = useRef(new Map<string, { start: number; end: number }>());
  const mounted = useRef(true);
  const libraryRequest = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++libraryRequest.current;
    const result = await api<NotebookLibrary>('/api/journal/library');
    if (mounted.current && request === libraryRequest.current) setLibrary({ ...EMPTY_LIBRARY, ...result });
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!readOnly) {
      setLoading(true);
      void refresh().catch(failure => {
        if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
      }).finally(() => { if (mounted.current) setLoading(false); });
    }
    return () => { mounted.current = false; };
  }, [readOnly, refresh]);
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

  const active = value.sections.find(section => section.id === selected);
  const progress = checklistProgress(value.sections);
  const closeQuickAdd = () => {
    quickDialog.current?.close();
    setQuickOpen(false);
  };
  const updateSection = (id: string, patch: Partial<NoteSection>) => {
    onChange({ ...value, sections: value.sections.map(section => section.id === id ? { ...section, ...patch } : section) });
  };
  /** 自己手输的条目名：直接记进条目收藏，下次在「选择条目」里带星出现。 */
  const rememberChapter = async (title: string) => {
    const clean = title.trim();
    if (!clean) return;
    try {
      await api('/api/journal/chapters/favorite', { title: clean, group: null, favorite: true }, { keepalive: true });
      await refresh();
    } catch { /* 收藏失败不影响写笔记 */ }
  };
  const addChapter = (title = '', group: string | null = null, checklist = false, remember = false) => {
    if (value.sections.length >= MAX_SECTIONS) return;
    const section = newSection(title, group, checklist);
    onChange({ ...value, sections: [...value.sections, section] });
    setSelected(section.id);
    if (remember && title.trim()) void rememberChapter(title);
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
    if (selected?.startsWith('drawing:')) {
      if (!evidence?.insertText?.(selected.slice(8), text)) setError('图形已变化，请重新选择图表批注目标');
      return;
    }
    const goalId = selected === 'body' ? 'body' : active?.id;
    if (!goalId) { setError('请选择插入位置'); return; }
    const content = goalId === 'body' ? value.body : active!.body;
    const { body, position } = insertAt(content, text, carets.current.get(goalId));
    if (body.length > (goalId === 'body' ? 10000 : 3000)) { setError('内容已达字数上限'); return; }
    if (goalId === 'body') onChange({ ...value, body });
    else updateSection(goalId, { body });
    carets.current.set(goalId, { start: position, end: position });
    window.requestAnimationFrame(() => areas.current.get(goalId)?.setSelectionRange(position, position));
    setError(''); setMessage('已插入，可继续选择常用语');
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
  useEffect(() => {
    if (quickOpen && !quickDialog.current?.open) quickDialog.current?.showModal();
  }, [quickOpen]);
  const openQuickAdd = () => {
    setPick([]);
    setLibraryExpanded(false);
    setChapterDraft('');
    setError('');
    setMessage('');
    setQuickOpen(true);
  };
  const togglePick = (title: string) => setPick(list => list.includes(title) ? list.filter(item => item !== title) : [...list, title]);
  const pickCustom = () => {
    const title = chapterDraft.trim();
    if (!title) return;
    setChapterDraft('');
    setPick(list => list.includes(title) ? list : [...list, title]);
    void rememberChapter(title);
  };
  /** 已选的条目一次性加到笔记末尾（跳过已在笔记里的）。 */
  const applyPick = () => {
    if (!pick.length) return;
    const room = Math.max(0, MAX_SECTIONS - value.sections.length);
    const fresh = pick.filter(title => !chapterExists(title)).slice(0, room);
    if (fresh.length) {
      const sections = [...value.sections, ...fresh.map(title => newSection(title))];
      onChange({ ...value, sections });
      setSelected(sections[value.sections.length]?.id ?? null);
    }
    setPick([]);
    closeQuickAdd();
  };
  /** 把已选的这套条目存成模板（只存标题和顺序）。 */
  const savePickTemplate = () => {
    const name = templateName.trim();
    if (!name || !pick.length) return;
    const structure = templateStructure(pick.map(title => newSection(title)));
    void run(async () => {
      await api('/api/journal/templates', { name, sections: structure, phrases: templatePhrases });
      await refresh();
      setTemplateName('');
      setMessage('已把已选条目存为模板，不含本次正文与勾选。');
    });
  };
  const favoriteChapter = async (title: string, group?: string | null) => {
    await api('/api/journal/chapters/favorite', { title, group, favorite: !library.chapters.some(row => row.title === title && row.favorite) }, { keepalive: true });
    await refresh();
  };

  const openSummary = () => {
    setSummaryOpen(true);
    setCopied(false);
    if (!readOnly) void api<Stats>('/api/journal/stats').then(setStats).catch(() => setStats(null));
  };
  const summaryText = summarizeNote(value);
  const chapterExists = (title: string) => value.sections.some(section => section.title.trim() === title);
  const full = value.sections.length >= MAX_SECTIONS;
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
    return <section key={section.id} className={`notebook-section${isChecklist(section) && section.checked ? ' is-checked' : ''}${active?.id === section.id ? ' is-selected' : ''}`}>
      <div className="notebook-section-head">
        {isChecklist(section) && <label className="notebook-check" title="已检查，表示这一项已经看过，不代表交易条件成立">
          <input type="checkbox" checked={section.checked} disabled={readOnly} aria-label={`已检查：${section.title || `第 ${index + 1} 条`}`} onChange={event => updateSection(section.id, { checked: event.target.checked })}/>
          <span className="sr-only">已检查</span>
        </label>}
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
          {isChecklist(section) && !!verdict && <span className={`notebook-verdict is-${verdict}`}>{verdictLabel(verdict)}</span>}
          <p className="notebook-section-content">{section.body || '未填写内容'}</p>
          {!!section.evidence?.length && <div className="notebook-evidence-row">
            {section.evidence.map((item, order) => <span className="notebook-evidence" key={item.id}>
              <button type="button" title={item.caption} onMouseEnter={() => evidence?.select([item.drawing_id])} onMouseLeave={() => evidence?.select(null)} onClick={() => evidence?.goTo(item.timeframe, item.anchor_ms)}>{circles[order] ?? String(order + 1)}{item.caption}</button>
            </span>)}
          </div>}
        </div>
        : <>
          {isChecklist(section) && <div className="notebook-verdicts" role="group" aria-label={`${section.title || `第 ${index + 1} 条`}的结论`}>
            <span className="notebook-verdicts-label">结论</span>
            {VERDICTS.map(choice => <button
              key={choice.id}
              type="button"
              aria-pressed={verdict === choice.id}
              className={`notebook-verdict-btn${verdict === choice.id ? ` is-${choice.id}` : ''}`}
              onClick={() => updateSection(section.id, { verdict: verdict === choice.id ? null : choice.id, checked: true })}
            >{choice.label}</button>)}
          </div>}
          <textarea
            ref={node => { if (node) areas.current.set(section.id, node); else areas.current.delete(section.id); }}
            aria-label={`${section.title || `第 ${index + 1} 条`}内容`}
            value={section.body}
            maxLength={3000}
            placeholder="写下判断、依据或事后发现……"
            onFocus={() => setSelected(section.id)}
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

          {selected === section.id && palette}
          <div className="notebook-section-foot">
            <button type="button" className="link" onClick={() => setSelected(section.id)}>常用语</button>
            <button type="button" className="link" title={isChecklist(section) ? '变回普通条目：只写正文，不参与完成度' : '转成可勾选的检查项：勾选后计入顶部完成度'} aria-pressed={isChecklist(section)} onClick={() => updateSection(section.id, { checklist: !isChecklist(section) })}>{isChecklist(section) ? '转为普通条目' : '转为检查项'}</button>
            <button type="button" className="link" disabled={full} title="在同一分组下再加一条检查项" onClick={() => addChapter('新检查项', section.group || section.title, true)}>＋ 新检查项</button>
            <div className="notebook-foot-right">
              <button type="button" className="link" disabled={!picked.trim() || busy} title="把选中文字存成常用语" onClick={() => savePhrase(picked)}>存选中为常用语</button>
              <button type="button" className="link" title="最多保存 500 字" disabled={!section.body.trim() || section.body.trim().length > 500 || busy} onClick={() => savePhrase(section.body)}>存为常用语</button>
            </div>
          </div>
        </>}
    </section>;
  };

  const palette = <div className="notebook-inline-phrases">
    {evidence?.insertText && <button type="button" className="link" onClick={() => {
      const rows = evidence.list(); setCandidates(rows);
      if (rows.length) setSelected('drawing:' + rows[0].id);
      else setError('当前图表还没有画线，先添加图形再插入批注。');
    }}>写入图表批注</button>}
    <label className="notebook-target">插入到<select aria-label="常用语插入位置" value={selected ?? 'body'} onFocus={() => setCandidates(evidence?.list() ?? [])} onChange={event => setSelected(event.target.value)}>
      <option value="body">自由笔记</option>
      {value.sections.map(section => <option key={section.id} value={section.id}>{section.title || '未命名章节'}</option>)}
      {candidates.map(item => <option key={item.id} value={'drawing:' + item.id}>图表批注：{item.text || item.type}</option>)}
    </select></label>
    <PhrasePalette context={(active?.group || '') + (active?.title || '')} phrases={library.phrases} template={activeTemplate?.phrases ?? []} insert={insertPhrase} pin={togglePin} save={savePhrase} remove={id => void run(async () => { await api('/api/journal/library/remove', { phrase_id: id }); await refresh(); })} />
  </div>;
  return <div className={`review-notebook${readOnly ? ' is-readonly' : ''}`}>
    <div className="notebook-heading">
      <strong>复盘笔记</strong>
      <span>{progress.total ? `完成 ${progress.done}/${progress.total}` : '条目与清单都可自由搭配'}</span>
    </div>
    {activeTemplate && <div className="notebook-active-template"><span>模板：{activeTemplate.name}</span><button type="button" onClick={() => setActiveTemplate(null)}>清除</button></div>}
    {!readOnly && <>
      <div className="notebook-toolbar">
        <button type="button" aria-haspopup="dialog" onClick={openQuickAdd}>＋ 条目 / 模板</button>
        <button type="button" aria-expanded={summaryOpen} onClick={() => (summaryOpen ? setSummaryOpen(false) : openSummary())}>复盘摘要</button>
        <button type="button" className="notebook-inline-toggle" aria-label="直接输入新条目" aria-expanded={inlineOpen} title="直接输入条目名称，回车添加" onClick={() => setInlineOpen(open => !open)}>＋</button>
      </div>
      {inlineOpen && <form className="notebook-inline-add" onSubmit={event => {
        event.preventDefault();
        const title = inlineTitle.trim();
        if (!title) return;
        addChapter(title, null, false, true);
        setInlineTitle('');
      }}>
        <input autoFocus maxLength={80} value={inlineTitle} placeholder="输入条目名称，回车添加" aria-label="新条目名称"
          onChange={event => setInlineTitle(event.target.value)}
          onKeyDown={event => { if (event.key === 'Escape') { setInlineOpen(false); setInlineTitle(''); } }} />
        <button type="submit" disabled={!inlineTitle.trim()}>添加</button>
        <button type="button" onClick={() => { setInlineOpen(false); setInlineTitle(''); }}>取消</button>
      </form>}
    </>}

    <div className="notebook-blocks">
      {blocks(value.sections).map(block => {
        if (block.kind === 'loose') return renderSection(block.section, block.index);
        const isCollapsed = collapsed.has(block.name);
        const groupProgress = checklistProgress(block.members.map(item => item.section));
        return <div className="notebook-group" key={`${block.name}:${block.members[0]!.section.id}`}>
          <div className="notebook-group-head">
            <button type="button" className="notebook-group-toggle" aria-expanded={!isCollapsed} title={isCollapsed ? '展开' : '收起'} onClick={() => toggleGroup(block.name)}>
              <span className="notebook-group-caret" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
              <span className="notebook-group-name">{block.name}</span>
            </button>
            <span className="notebook-group-count">{groupProgress.total ? groupProgress.done + "/" + groupProgress.total : ""}</span>
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
      <section aria-label="条目选择">
        <h5>选择条目 <span className="notebook-pick-hint">可多选，选好一起加入</span></h5>
        <div className="notebook-phrases">{[...new Set([...CHAPTERS, ...library.chapters.map(row => row.title)])].map(title => {
          const inNote = chapterExists(title), picked = pick.includes(title);
          return <span className={`notebook-phrase${picked ? ' is-picked' : ''}${inNote ? ' is-in-note' : ''}`} key={title} title={inNote ? '已经在笔记里，不能重复添加' : undefined}>
            <button type="button" disabled={full || inNote} aria-pressed={picked} title={inNote ? '已经在笔记里' : (picked ? '移出已选' : '加入已选')} onClick={() => togglePick(title)}>{title}</button>
            <button type="button" aria-label={'收藏条目 ' + title} aria-pressed={library.chapters.some(row => row.title === title && row.favorite)} onClick={() => void run(() => favoriteChapter(title))}>{library.chapters.some(row => row.title === title && row.favorite) ? '★' : '☆'}</button>
          </span>;
        })}</div>
      </section>
      <form className="notebook-library-form" onSubmit={event => { event.preventDefault(); pickCustom(); }}>
        <input autoFocus aria-label="条目名称" maxLength={80} placeholder="自定义条目名称" value={chapterDraft} onChange={event => setChapterDraft(event.target.value)} />
        <button type="submit" disabled={full || !chapterDraft.trim()}>加入已选</button>
      </form>
      <section aria-label="已选条目">
        <h5>已选{pick.length ? `（${pick.length}）` : ''}</h5>
        {pick.length ? <div className="notebook-phrases">{pick.map(title => <span className="notebook-phrase is-picked" key={title}>
          <span>{title}</span><button type="button" className="notebook-phrase-remove" aria-label={`移除已选 ${title}`} onClick={() => togglePick(title)}>×</button>
        </span>)}</div> : <p className="notebook-library-hint">点上面的条目或输入名称，选好后一起加到笔记。</p>}
        <div className="notebook-pick-actions">
          <input aria-label="模板名称" maxLength={80} placeholder="给这套条目起个名字（存为模板）" value={templateName} onChange={event => setTemplateName(event.target.value)} />
          <button type="button" disabled={busy || !pick.length || !templateName.trim()} onClick={savePickTemplate}>保存模板</button>
          <button type="button" className="primary" disabled={!pick.length || value.sections.length >= MAX_SECTIONS} onClick={applyPick}>添加到笔记</button>
        </div>
      </section>
      {full && <p className="dim">每篇笔记最多 {MAX_SECTIONS} 个条目 / 检查项。</p>}
      {message && <p className="notebook-feedback" role="status">{message}</p>}
      {error && <p className="notebook-error" role="alert">{error}</p>}
      <details className="notebook-library" open={libraryExpanded} onToggle={event => setLibraryExpanded(event.currentTarget.open)}>
      <summary>我的模板 / 保存组合</summary>
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
      <p className="notebook-library-hint">只保存条目标题、分组和顺序，不会保存正文、证据或检查结果。</p>

      </details>
    </dialog>}

    {summaryOpen && <div className="notebook-summary">
      <div className="notebook-summary-head">
        <strong>复盘摘要</strong>
        <span>由笔记生成，只读。</span>
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

    <div className="notebook-free"><label htmlFor="note-body">自由笔记</label>{readOnly ? <p className="notebook-section-content">{value.body || '暂无自由笔记'}</p> : <>
      <textarea id="note-body" ref={node => { if (node) areas.current.set('body', node); else areas.current.delete('body'); }} value={value.body} maxLength={10000} placeholder="直接写下想法，也可以添加章节或检查项。" onFocus={() => setSelected('body')} onSelect={event => rememberCaret({ id: 'body' } as NoteSection, event.currentTarget)} onChange={event => onChange({ ...value, body: event.target.value })} />
      {(selected === 'body' || selected?.startsWith('drawing:') || !selected) && palette}
      <button type="button" className="link" disabled={!selection?.text.trim()} onClick={() => savePhrase(selection?.text || '')}>存选中为常用语</button>
    </>}</div>
    {!readOnly && !quickOpen && <><p className="notebook-feedback" role="status">{message}</p>{error && <p className="notebook-error" role="alert">{error}</p>}</>}
  </div>;
}
