import { useState } from 'react';
import presets from '../../../resources/publicChapterPresets.json';
import { frequentFirst, SYSTEM_PHRASES, type NotebookPhrase } from './notebookModel';

interface Props {
  context: string;
  phrases: NotebookPhrase[];
  template: string[];
  insert(text: string, id?: string | number): void;
  pin(phrase: NotebookPhrase): void;
  save(text: string): void;
  remove(id: string | number): void;
}

/** Inline text suggestions; every click inserts text only and leaves the palette open. */
export function PhrasePalette({ context, phrases, template, insert, pin, save, remove }: Props) {
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [cloud, setCloud] = useState(false);
  const personal = frequentFirst(phrases);
  const terms = presets.slice(4);
  const topic = context.replace('关键位', '位置').replace('入场模型', '确认 执行').replace('订单管理', '管理');
  const relevant = terms.filter(term => term.group && topic.includes(term.group));
  const quick = [...new Set([...personal.filter(p => p.pinned).map(p => p.text), ...template, ...relevant.map(t => t.title), ...[...personal].sort((a,b) => b.last_used-a.last_used).map(p => p.text), ...SYSTEM_PHRASES])].slice(0, 8);
  const matches = (text: string) => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const use = (text: string) => insert(text, personal.find(p => p.text === text)?.id);
  return <div className="phrase-palette">
    <div className="notebook-phrases" aria-label="正文常用语">{quick.map(text => <button type="button" key={text} onMouseDown={event => event.preventDefault()} onClick={() => use(text)}>{text}</button>)}</div>
    <details>
      <summary>更多常用语 / 找灵感</summary>
      <input type="search" aria-label="搜索正文常用语" placeholder="搜索词语或短句" value={query} onChange={event => setQuery(event.target.value)} />
      <p className="dim">我的常用语（仅自己可见）</p>
      <div className="notebook-phrases">{personal.filter(p => matches(p.text)).map(phrase => <span className="notebook-phrase" key={phrase.id}>
        <button type="button" aria-label={`固定常用语 ${phrase.text}`} aria-pressed={!!phrase.pinned} onClick={() => pin(phrase)}>{phrase.pinned ? '★' : '☆'}</button>
        <button type="button" onClick={() => insert(phrase.text, phrase.id)}>{phrase.text}</button>
        <button type="button" aria-label={`删除常用语 ${phrase.text}`} onClick={() => remove(phrase.id)}>×</button>
      </span>)}</div>
      <div className="notebook-library-form"><input aria-label="新常用语" maxLength={500} value={draft} placeholder="保存自己的词语或短句" onChange={event => setDraft(event.target.value)} /><button type="button" disabled={!draft.trim()} onClick={() => { save(draft); setDraft(''); }}>保存</button></div>
      <button type="button" aria-pressed={cloud} onClick={() => setCloud(!cloud)}>{cloud ? '切换列表' : '词云找灵感'}</button>
      <div className={cloud ? 'notebook-cloud' : 'notebook-phrases'} aria-label="系统正文词库">{[...new Set([...template, ...terms.map(t => t.title), ...SYSTEM_PHRASES])].filter(matches).map(text => <button type="button" key={text} style={cloud ? { fontSize: `${14 + (terms.find(t => t.title === text)?.weight ?? 2) * 2}px` } : undefined} onClick={() => use(text)}>{text}</button>)}</div>
    </details>
  </div>;
}
