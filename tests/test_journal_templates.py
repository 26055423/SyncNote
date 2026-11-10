"""Notebook/library checks on synthetic, in-memory trades only."""
import json,sqlite3,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import journal
import journal_templates as library

class JournalTemplates(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:');self.addCleanup(self.db.close);self.db.row_factory=sqlite3.Row
  self.db.execute('PRAGMA foreign_keys=ON')
  self.db.executescript('CREATE TABLE trades(person TEXT,ticket TEXT,payload TEXT,PRIMARY KEY(person,ticket)); CREATE TABLE chart_states(person TEXT,ticket TEXT,state TEXT);')
  for person in ['alice','bob']:
   for ticket in ['1','2']:self.db.execute('INSERT INTO trades VALUES(?,?,?)',(person,ticket,'{}'))
  journal.initialize(self.db)

 def note(self,ticket='1',**extra):
  return journal.save(self.db,'alice',{'ticket':ticket,'body':'','tags':[],**extra})['note']

 def section(self,title='我自己的章节',**extra):
  return {'id':'section-a','title':title,'body':'','checked':False,**extra}

 def test_old_schema_and_old_client_preserve_new_sections(self):
  self.db.execute('INSERT INTO trade_notes VALUES(?,?,?,?,?)',('alice','2','旧笔记','[]',1))
  self.assertEqual(journal.notes(self.db,'alice')['notes']['2']['sections'],[])
  self.note(sections=[self.section(body='扫了低点，等待回踩')])
  old_client=self.note(body='旧客户端修改文字')
  self.assertEqual(old_client['sections'][0]['body'],'扫了低点，等待回踩')
  self.assertEqual(journal.notes(self.db,'alice')['notes']['1']['body'],'旧客户端修改文字')

 def test_blank_scaffold_is_not_reviewed_but_content_or_check_is(self):
  self.note(sections=[self.section()])
  self.assertEqual(journal.reviewed(self.db,'alice'),[])
  self.note(sections=[self.section(checked=True)])
  self.assertEqual(journal.reviewed(self.db,'alice'),['1'])
  self.note(sections=[self.section(body='POI 后出现反转')])
  self.assertEqual(journal.reviewed(self.db,'alice'),['1'])
  self.note(sections=[])
  self.assertEqual(journal.reviewed(self.db,'alice'),[])

 def test_chapters_count_distinct_meaningful_notes_not_save_clicks(self):
  for _ in range(3):self.note(sections=[self.section(body='内容')])
  self.assertEqual(library.library(self.db,'alice')['chapters'][0]['uses'],1)
  self.note('2',sections=[self.section(checked=True)])
  self.assertEqual(library.library(self.db,'alice')['chapters'][0]['uses'],2)
  self.assertEqual(library.library(self.db,'bob')['chapters'],[])

 def test_chapter_favorite_is_private_and_merges_with_used_titles(self):
  title='我收藏的条目'
  library.favorite_chapter(self.db,'alice',{'title':' '+title+' ','group':'结构'})
  library.favorite_chapter(self.db,'alice',{'title':title,'group':'别的分组'})
  self.assertEqual(library.library(self.db,'alice')['chapters'],[
   {'title':title,'group':'结构','favorite':True,'uses':0,'last_used':0}])
  self.assertEqual(library.library(self.db,'bob')['chapters'],[])
  self.assertNotIn(title,[row['title'] for row in library.public_chapters(self.db)['chapters']])
  self.note(sections=[self.section(title,checked=True)])
  rows=library.library(self.db,'alice')['chapters']
  self.assertEqual([(row['title'],row['favorite'],row['uses']) for row in rows],[(title,True,1)])

 def test_templates_strip_trade_content_and_checks_but_keep_custom_order(self):
  created=library.save_template(self.db,'alice',{'name':'我的开单前五问','sections':[self.section('先问自己',body='私人交易细节',checked=True),self.section('再看位置',id='b')]})['template']
  self.assertEqual([row['title'] for row in created['sections']],['先问自己','再看位置'])
  self.assertTrue(all(not row['body'] and row['checked'] is False for row in created['sections']))
  self.assertEqual(created['uses'],0)
  library.library_item(self.db,'alice',{'template_id':created['id']})
  self.assertEqual(library.library(self.db,'alice')['templates'][0]['uses'],1)
  library.save_template(self.db,'alice',{'id':created['id'],'name':'重新取名','sections':created['sections']})
  self.assertEqual(library.library(self.db,'alice')['templates'][0]['name'],'重新取名')

 def test_private_library_cannot_be_read_changed_used_or_removed_by_other_owner(self):
  template=library.save_template(self.db,'alice',{'name':'私有','sections':[self.section()]})['template']
  phrase=library.save_phrase(self.db,'alice',{'text':'扫了低点'})['phrase']
  self.assertEqual(library.library(self.db,'bob'),{'templates':[],'phrases':[],'chapters':[]})
  for key,ident in [('template_id',template['id']),('phrase_id',phrase['id'])]:
   for remove in [False,True]:
    with self.assertRaises(library.JournalError) as error:library.library_item(self.db,'bob',{key:ident},remove)
    self.assertEqual(error.exception.code,404)
  with self.assertRaises(library.JournalError) as error:library.save_template(self.db,'bob',{'id':template['id'],'name':'stolen','sections':[self.section()]})
  self.assertEqual(error.exception.code,404)

 def test_phrase_upsert_and_frequency_ranking(self):
  a=library.save_phrase(self.db,'alice',{'text':' 扫了低点 '})['phrase']
  self.assertEqual(library.save_phrase(self.db,'alice',{'text':'扫了低点'})['phrase']['id'],a['id'])
  library.save_phrase(self.db,'alice',{'text':'等待确认'})
  library.library_item(self.db,'alice',{'phrase_id':a['id']})
  result=library.library(self.db,'alice')['phrases']
  self.assertEqual(len(result),2);self.assertEqual(result[0]['text'],'扫了低点');self.assertEqual(result[0]['uses'],1)
  library.library_item(self.db,'alice',{'phrase_id':a['id']},True)
  self.assertEqual([p['text'] for p in library.library(self.db,'alice')['phrases']],['等待确认'])

 def test_validation_and_failed_save_leave_previous_note_untouched(self):
  self.note(body='保留',sections=[self.section(body='原有章节')])
  invalid=[[self.section(checked='true')],[self.section(title=' ')],[self.section(body='x'*3001)],[self.section(),self.section()],[self.section(id='')]]
  for sections in invalid:
   with self.assertRaises(library.JournalError):self.note(body='不能写入',sections=sections)
  saved=journal.notes(self.db,'alice')['notes']['1']
  self.assertEqual(saved['body'],'保留');self.assertEqual(saved['sections'][0]['body'],'原有章节')
  with self.assertRaises(library.JournalError):self.note(sections=[self.section(id=str(i),body='x'*2000) for i in range(16)])
  with self.assertRaises(library.JournalError):journal.save(self.db,'alice',{'ticket':'missing','body':'not owned'})

 def test_group_and_verdict_are_separate_from_checked(self):
  saved=self.note(sections=[self.section('扫低后出现 Flip',group='结构',verdict='yes')])
  section=saved['sections'][0]
  self.assertEqual(section['group'],'结构');self.assertEqual(section['verdict'],'yes');self.assertTrue(section['checked']==False or section['checked'] is False)
  self.note(sections=[self.section('不适用项',group='管理',verdict='na')])
  self.assertEqual(self.note()['sections'][0]['verdict'],'na')
  for broken in [self.section(verdict='maybe'),self.section(group='x'*41)]:
   with self.assertRaises(library.JournalError):self.note(sections=[broken])

 def test_template_keeps_group_and_order_but_drops_verdict(self):
  created=library.save_template(self.db,'alice',{'name':'结构组合','sections':[
   {'id':'g1','title':'方向','group':'方向判断','verdict':'yes','checked':True,'body':'内容'},
   {'id':'g2','title':'位置','group':'位置','verdict':None,'checked':False,'body':''},
   {'id':'g3','title':'自由章节','body':'','checked':False}]})['template']
  self.assertEqual([row['group'] for row in created['sections']],['方向判断','位置',None])
  self.assertTrue(all(row['verdict'] is None and not row['body'] and row['checked'] is False for row in created['sections']))

 def test_template_phrases_are_optional_validated_and_kept_on_rename(self):
  template=library.save_template(self.db,'alice',{'name':'带话术','sections':[self.section()],'phrases':[' 扫了低点 ','扫了低点','拿了 IDM']})['template']
  self.assertEqual(template['phrases'],['扫了低点','拿了 IDM'])
  renamed=library.save_template(self.db,'alice',{'id':template['id'],'name':'改名','sections':template['sections']})['template']
  self.assertEqual(renamed['phrases'],['扫了低点','拿了 IDM'])
  with self.assertRaises(library.JournalError):library.save_template(self.db,'alice',{'name':'太长','sections':[self.section()],'phrases':['x'*501]})
  with self.assertRaises(library.JournalError):library.save_template(self.db,'alice',{'name':'太多','sections':[self.section()],'phrases':['p%d'%i for i in range(21)]})

 def test_phrase_pin_ranks_first_and_only_owner_can_pin(self):
  a=library.save_phrase(self.db,'alice',{'text':'扫了低点'})['phrase']
  library.save_phrase(self.db,'alice',{'text':'等待确认'})
  library.library_item(self.db,'alice',{'phrase_id':a['id']})
  pinned=library.pin_phrase(self.db,'alice',{'id':a['id'],'pinned':True})
  self.assertTrue(pinned['pinned'])
  self.assertEqual(library.library(self.db,'alice')['phrases'][0]['text'],'扫了低点')
  self.assertTrue(library.library(self.db,'alice')['phrases'][0]['pinned'])
  with self.assertRaises(library.JournalError) as error:library.pin_phrase(self.db,'bob',{'id':a['id'],'pinned':True})
  self.assertEqual(error.exception.code,404)

 def test_stats_use_saved_notes_and_verdicts_only(self):
  self.note('1',sections=[{'id':'a1','title':'方向','group':'方向','checked':True,'verdict':'yes','body':'看多'},
                          {'id':'a2','title':'位置','group':'位置','checked':False,'body':'等回踩'}])
  self.note('2',sections=[{'id':'b1','title':'方向','group':'方向','checked':True,'verdict':'no','body':'看空'},
                          {'id':'b2','title':'位置','group':'位置','checked':False,'body':'没等到'}])
  result=library.stats(self.db,'alice')
  self.assertEqual(result['notes'],2)
  self.assertEqual(result['verdicts']['yes'],1);self.assertEqual(result['verdicts']['no'],1)
  by_title={row['title']:row for row in result['titles']}
  self.assertEqual(by_title['方向']['checked'],2)
  self.assertEqual(by_title['位置']['checked'],0)
  self.assertEqual(result['skipped'][0]['title'],'位置')

 def test_section_evidence_roundtrips_but_templates_drop_it(self):
  evidence=[{'id':'ev-1','caption':'15m 需求区：首次回踩','drawing_id':'d-1','timeframe':'15','anchor_ms':1761998400000,'snapshot':{'type':'trendline'}}]
  saved=self.note(sections=[self.section('结构',group='确认',evidence=evidence)])['sections'][0]
  self.assertEqual(saved['evidence'][0]['caption'],'15m 需求区：首次回踩')
  self.assertEqual(saved['evidence'][0]['anchor_ms'],1761998400000)
  template=library.save_template(self.db,'alice',{'name':'带证据','sections':[self.section('结构',group='确认',evidence=evidence)]})['template']
  self.assertEqual(template['sections'][0]['evidence'],[])
  for broken in ([{'id':'x','caption':'c','drawing_id':'d','timeframe':'15','anchor_ms':'now'}],
                 [{'id':'','caption':'c','drawing_id':'d','timeframe':'15'}],
                 [{'id':'x','caption':'c'*201,'drawing_id':'d','timeframe':'15'}]):
   with self.assertRaises(library.JournalError):self.note(sections=[self.section('坏证据',evidence=broken)])

 def test_stats_count_blank_unchecked_items_in_completed_notes(self):
  for ticket in ('1','2'):
   self.note(ticket,sections=[self.section('方向',checked=True,verdict='yes'),self.section('风险',id='risk')])
  result=library.stats(self.db,'alice')
  self.assertEqual(result['notes'],2)
  self.assertEqual([(row['title'],row['total'],row['checked'],row['rate']) for row in result['skipped']],[('风险',2,0,0)])
  self.assertEqual(result['verdicts'],{'yes':2,'no':0,'unclear':0,'na':0})
  self.note('2',sections=[self.section('方向'),self.section('风险',id='risk')])
  self.assertEqual(library.stats(self.db,'alice')['notes'],1)
  self.assertEqual(library.stats(self.db,'alice')['skipped'],[])

 def test_public_chapter_cloud_counts_people_not_clicks_and_needs_meaningful_content(self):
  self.db.executescript("CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,nickname TEXT); INSERT OR IGNORE INTO users VALUES('alice','A'),('bob','B');")
  for ticket,person in (('1','alice'),('2','alice'),('1','bob')):
   self.db.execute('INSERT OR IGNORE INTO trades(person,ticket,payload) VALUES(?,?,?)',(person,ticket,'{}'))
  library_stats=self.note('1',sections=[{'id':'a1','title':'扫低后 Flip','group':'结构','checked':True,'body':'x'}])
  self.note('2',sections=[{'id':'a2','title':'扫低后 Flip','group':'结构','checked':True,'body':'y'},{'id':'a3','title':'空章节','body':'','checked':False}])
  journal.save(self.db,'bob',{'ticket':'1','body':'','tags':[],'sections':[{'id':'b1','title':'扫低后 Flip','group':'结构','checked':True,'body':'z'}]})
  cloud=library.public_chapters(self.db)
  titles={row['title']:row for row in cloud['chapters']}
  self.assertEqual(titles['扫低后 Flip']['users'],2)
  self.assertEqual(titles['扫低后 Flip']['uses'],3)
  self.assertEqual(titles['扫低后 Flip']['group'],'结构')
  self.assertNotIn('空章节',titles)
  cloud_rows=library.public_chapters(self.db)['chapters']
  self.assertTrue(cloud_rows[0]['users']>=1 and cloud_rows[0]['title']=='扫低后 Flip')
  self.assertTrue(any(row.get('system') and row['title']=='订单块（OB）' for row in cloud_rows))
  self.assertTrue(all(row['users']>=0 for row in cloud_rows))

 def test_template_pin_sorts_first_and_rejects_other_owners(self):
  first=library.save_template(self.db,'alice',{'name':'常用','sections':[self.section()]})['template']
  library.save_template(self.db,'alice',{'name':'以后','sections':[{'id':'other','title':'另一套','body':'','checked':False}]})
  self.assertEqual(len(library.library(self.db,'alice')['templates']),2)
  library.pin_item(self.db,'alice',{'template_id':first['id'],'pinned':True})
  ordered=library.library(self.db,'alice')['templates']
  self.assertEqual(ordered[0]['name'],'常用');self.assertTrue(ordered[0]['pinned'])
  with self.assertRaises(library.JournalError) as error:library.pin_item(self.db,'bob',{'template_id':first['id'],'pinned':True})
  self.assertEqual(error.exception.code,404)

 def test_repeat_use_within_five_seconds_counts_once(self):
  template=library.save_template(self.db,'alice',{'name':'快速点两次','sections':[self.section()]})['template']
  library.library_item(self.db,'alice',{'template_id':template['id']})
  library.library_item(self.db,'alice',{'template_id':template['id']})
  self.assertEqual(library.library(self.db,'alice')['templates'][0]['uses'],1)
  self.db.execute('UPDATE journal_templates SET last_used=0 WHERE id=?',(template['id'],))
  library.library_item(self.db,'alice',{'template_id':template['id']})
  self.assertEqual(library.library(self.db,'alice')['templates'][0]['uses'],2)

 def test_template_names_do_not_silently_overwrite_and_deletion_keeps_notes(self):
  data={'name':'自己的名字','sections':[self.section()]}
  template=library.save_template(self.db,'alice',data)['template']
  with self.assertRaises(library.JournalError) as error:library.save_template(self.db,'alice',data)
  self.assertEqual(error.exception.code,409)
  self.note(sections=[self.section(body='实际复盘')])
  library.library_item(self.db,'alice',{'template_id':template['id']},True)
  self.assertEqual(library.library(self.db,'alice')['templates'],[])
  self.assertEqual(journal.notes(self.db,'alice')['notes']['1']['sections'][0]['body'],'实际复盘')

if __name__=='__main__':unittest.main()
