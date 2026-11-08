import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import {
  appendPhrase, appendTemplate, frequentFirst, moveSection, newSection, STARTER_CHAPTERS,
  SYSTEM_PHRASES, templateStructure, type NotebookLibrary, type NotebookValue, type NoteSection,
} from './notebookModel';
export type { NotebookValue, NoteSection } from './notebookModel';

interface Props {
  value: NotebookValue;
  onChange(value: NotebookValue): void;
  readOnly: boolean;
  onError?(message: string): void;
}
const EMPTY_LIBRARY: NotebookLibrary = { templates: [], phrases: [], chapters: [] };

/** User-owned chapters and reusable structures; no trading-system taxonomy. */
export function ReviewNotebook({ value, onChange, readOnly, onError }: Props) {
  const [library, setLibrary] = useState<NotebookLibrary>(EMPTY_LIBRARY);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(value.sections[0]?.id ?? null);
  const [templateName, setTemplateName] = useState('');
  const [phraseText, setPhraseText] = useState('');
  const [editingTemplate, setEditingTemplate] = useState<string | number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!readOnly);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [removed, setRemoved] = useState<{ section: NoteSection; index: number } | null>(null);
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

  const active = value.sections.find(section => section.id === selected) ?? value.sections[0];
  const done = value.sections.filter(section => section.checked).length;
  const updateSection = (id: string, patch: Partial<NoteSection>) => {
    onChange({ ...value, sections: value.sections.map(section => section.id === id ? { ...section, ...patch } : section) });
  };
  const addChapter = (title = '') => {
    if (value.sections.length >= 30) return;
    const section = newSection(title);
    onChange({ ...value, sections: [...value.sections, section] });
    setSelected(section.id);
  };
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
  const insertPhrase = (text: string, id?: string | number) => {
    if (!active) { setError('先添加一个章节，再插入常用语。'); return; }
    const body = appendPhrase(active.body, text);
    if (body.length > 3000) { setError('这一章已接近 3000 字，无法继续插入。'); return; }
    updateSection(active.id, { body });
    setError(''); setMessage(`已插入「${active.title.trim() || '未命名章节'}」`);
    if (id != null) void api('/api/journal/library/use', { phrase_id: id }).then(refresh).catch(() => {});
  };
  const chapterChoices = frequentFirst(library.chapters).map(row => row.title).concat(STARTER_CHAPTERS)
    .filter((title, index, all) => all.indexOf(title) === index && !value.sections.some(section => section.title.trim() === title)).slice(0, 4);

  return <div className={`review-notebook${readOnly ? ' is-readonly' : ''}`}>
    <div className="notebook-heading"><strong>我的复盘章节</strong><span>{value.sections.length ? `已检查 ${done}/${value.sections.length}` : '按自己的习惯记录'}</span></div>
    {!readOnly && <>
      <div className="notebook-toolbar">
        <button type="button" onClick={() => addChapter()} disabled={value.sections.length >= 30}>＋ 添加章节</button>
        <button type="button" aria-expanded={libraryOpen} onClick={() => setLibraryOpen(!libraryOpen)}>我的模板与常用语</button>
      </div>
      {!value.sections.length && <div className="notebook-empty"><p>标题、顺序和内容都由你决定。可以从空白开始，也可以选一个常用章节。</p></div>}
      {!!chapterChoices.length && value.sections.length < 30 && <div className="notebook-chapter-suggestions" aria-label="推荐章节">
        <span>快捷添加</span>{chapterChoices.map(title => <button type="button" key={title} onClick={() => addChapter(title)}>{title}</button>)}
      </div>}
    </>}

    <div className="notebook-sections">
      {value.sections.map((section, index) => <section key={section.id} className={`notebook-section${section.checked ? ' is-checked' : ''}${active?.id === section.id ? ' is-selected' : ''}`}>
        <div className="notebook-section-head">
          <label className="notebook-check" title="已检查，表示这一项已经看过，不代表交易条件成立">
            <input type="checkbox" checked={section.checked} disabled={readOnly} aria-label={`已检查：${section.title || `第 ${index + 1} 章`}`} onChange={event => updateSection(section.id, { checked: event.target.checked })}/>
            <span className="sr-only">已检查</span>
          </label>
          {readOnly ? <h4>{section.title || `第 ${index + 1} 章`}</h4> : <input className="notebook-section-title" aria-label={`第 ${index + 1} 章标题`} maxLength={80} value={section.title} placeholder="给这一章起个名字" onFocus={() => setSelected(section.id)} onChange={event => updateSection(section.id, { title: event.target.value })}/>}
          {!readOnly && <div className="notebook-section-actions">
            <button type="button" disabled={index === 0} aria-label={`上移第 ${index + 1} 章`} title="上移" onClick={() => onChange({ ...value, sections: moveSection(value.sections, section.id, -1) })}>↑</button>
            <button type="button" disabled={index === value.sections.length - 1} aria-label={`下移第 ${index + 1} 章`} title="下移" onClick={() => onChange({ ...value, sections: moveSection(value.sections, section.id, 1) })}>↓</button>
            <button type="button" aria-label={`移除第 ${index + 1} 章`} title="移除章节，可撤销" onClick={() => {
              setRemoved({ section, index }); onChange({ ...value, sections: value.sections.filter(row => row.id !== section.id) });
            }}>×</button>
          </div>}
        </div>
        {readOnly ? <p className="notebook-section-content">{section.body || '未填写内容'}</p> : <>
          <textarea aria-label={`${section.title || `第 ${index + 1} 章`}内容`} value={section.body} maxLength={3000} placeholder="写下判断、依据或事后发现……" onFocus={() => setSelected(section.id)} onChange={event => updateSection(section.id, { body: event.target.value })}/>
          <div className="notebook-section-foot"><button type="button" className="link" onClick={() => { setSelected(section.id); setLibraryOpen(true); }}>插入常用语</button>
            <button type="button" className="link" title="最多保存 500 字" disabled={!section.body.trim() || section.body.trim().length > 500 || busy} onClick={() => void run(async () => {
              await api('/api/journal/phrases', { text: section.body.trim() }); await refresh(); setMessage('已保存到我的常用语');
            })}>存为常用语</button></div>
        </>}
      </section>)}
    </div>
    {!readOnly && removed && <div className="notebook-undo"><span>已移除「{removed.section.title || '未命名章节'}」</span><button type="button" className="link" disabled={value.sections.length >= 30} onClick={() => {
      const sections = [...value.sections]; sections.splice(Math.min(removed.index, sections.length), 0, removed.section);
      onChange({ ...value, sections }); setRemoved(null);
    }}>撤销移除</button></div>}

    {!readOnly && libraryOpen && <div className="notebook-library">
      <div className="notebook-library-head"><strong>我的模板与常用语</strong><button type="button" aria-label="收起模板与常用语" onClick={() => setLibraryOpen(false)}>×</button></div>
      <p className="notebook-library-hint">仅自己可见。按使用频率优先推荐，原有章节顺序由你决定。</p>
      {loading && <p className="notebook-library-hint">正在读取个人词库…</p>}
      <h5>章节组合</h5>
      {frequentFirst(library.templates).map(template => <div className="notebook-template" key={template.id}><div className="notebook-library-item">
        <button type="button" title={`添加 ${template.sections.length} 个章节；保留已有内容`} disabled={!template.sections.length || value.sections.length + template.sections.length > 30 || busy} onClick={() => {
          const sections = appendTemplate(value.sections, template);
          onChange({ ...value, sections }); setSelected(sections[value.sections.length]?.id ?? null);
          setMessage(`已添加「${template.name}」的章节，原有内容已保留。`);
          void api('/api/journal/library/use', { template_id: template.id }).then(refresh).catch(() => {});
        }}><span>{template.name}</span><small>{template.sections.length} 章 · 用过 {template.uses} 次</small></button>
        <button type="button" className="notebook-library-remove" aria-label={`编辑模板 ${template.name}`} disabled={busy} onClick={() => { setEditingTemplate(editingTemplate === template.id ? null : template.id); setEditingName(template.name); }}>编辑</button>
        <button type="button" className="notebook-library-remove" title="删除我的模板" aria-label={`删除模板 ${template.name}`} disabled={busy} onClick={() => void run(async () => {
          await api('/api/journal/library/remove', { template_id: template.id }); await refresh(); setMessage('模板已删除，当前笔记保留。');
        })}>×</button>
      </div>{editingTemplate === template.id && <div className="notebook-template-edit">
        <div className="notebook-library-form"><input aria-label={`模板 ${template.name} 的新名称`} maxLength={80} value={editingName} onChange={event => setEditingName(event.target.value)}/>
          <button type="button" disabled={busy || !editingName.trim()} onClick={() => void run(async () => {
            await api('/api/journal/templates', { id: template.id, name: editingName.trim(), sections: template.sections });
            await refresh(); setEditingTemplate(null); setMessage('模板名称已更新');
          })}>保存名称</button></div>
        <button type="button" className="link" disabled={busy || !templateStructure(value.sections).length || !editingName.trim()} onClick={() => void run(async () => {
          await api('/api/journal/templates', { id: template.id, name: editingName.trim(), sections: templateStructure(value.sections) });
          await refresh(); setEditingTemplate(null); setMessage('模板已更新为当前章节结构');
        })}>用当前章节更新此模板</button>
      </div>}</div>)}
      {!library.templates.length && <p className="notebook-library-hint">保存自己的章节组合，下次可以一键添加。</p>}
      <div className="notebook-library-form"><input aria-label="模板名称" maxLength={80} placeholder="给这套章节起个名字" value={templateName} onChange={event => setTemplateName(event.target.value)}/>
        <button type="button" disabled={busy || !templateName.trim() || !templateStructure(value.sections).length} onClick={() => void run(async () => {
          await api('/api/journal/templates', { name: templateName.trim(), sections: templateStructure(value.sections) });
          await refresh(); setTemplateName(''); setMessage('章节结构已存为模板，不含本次交易文字与勾选。');
        })}>保存组合</button></div>
      <p className="notebook-library-hint">只保存章节标题和顺序，复盘内容仍属于这笔交易。</p>

      <h5>常用语</h5>
      <label className="notebook-target">插入到<select aria-label="常用语插入章节" value={active?.id ?? ''} disabled={!value.sections.length} onChange={event => setSelected(event.target.value)}>
        {!value.sections.length && <option value="">先添加一个章节</option>}
        {value.sections.map((section, index) => <option key={section.id} value={section.id}>{section.title || `第 ${index + 1} 章`}</option>)}
      </select></label>
      {!!library.phrases.length && <div className="notebook-phrases" aria-label="我的常用语">{frequentFirst(library.phrases).map(phrase => <span className="notebook-phrase" key={phrase.id}>
        <button type="button" disabled={!active} title={`用过 ${phrase.uses} 次`} onClick={() => insertPhrase(phrase.text, phrase.id)}>{phrase.text}</button>
        <button type="button" className="notebook-phrase-remove" aria-label={`删除常用语 ${phrase.text}`} disabled={busy} onClick={() => void run(async () => {
          await api('/api/journal/library/remove', { phrase_id: phrase.id }); await refresh();
        })}>×</button>
      </span>)}</div>}
      <div className="notebook-phrases" aria-label="常用语示例">{SYSTEM_PHRASES.map(text => <button type="button" key={text} disabled={!active} onClick={() => insertPhrase(text)}>{text}</button>)}</div>
      <div className="notebook-library-form"><input aria-label="新常用语" maxLength={500} placeholder="写一句自己的常用语" value={phraseText} onChange={event => setPhraseText(event.target.value)}/>
        <button type="button" disabled={busy || !phraseText.trim()} onClick={() => void run(async () => {
          await api('/api/journal/phrases', { text: phraseText.trim() }); await refresh(); setPhraseText(''); setMessage('已保存到我的常用语');
        })}>保存</button></div>
    </div>}

    <div className="notebook-free"><label htmlFor="note-body">自由笔记</label>{readOnly ? <p className="notebook-section-content">{value.body || '暂无自由笔记'}</p> : <textarea id="note-body" value={value.body} maxLength={10000} placeholder="其他想法可以写在这里，原来的笔记也保留在这里。" onChange={event => onChange({ ...value, body: event.target.value })}/>}</div>
    {!readOnly && <><p className="notebook-feedback" role="status">{message}</p>{error && <p className="notebook-error" role="alert">{error}</p>}</>}
  </div>;
}
