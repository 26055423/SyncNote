"""Run SyncNote's actual bounded scheduler and ACK validator with synthetic MT5 APIs."""
import os,re,subprocess,tempfile,unittest
from pathlib import Path
from test_ea_history import compiler_environment,cpp_source

ROOT=Path(__file__).resolve().parents[1]

SCENARIOS=r'''
void require(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
const std::int64_t NOW=1800000000;
void init(CSyncNoteBars& b,std::int64_t now=NOW,string scope="scope",string account="1001",string server="Synthetic-Demo",string symbol="XAUUSD")
{b.Begin(scope,account,server,symbol,now);}
string ack(int tf,std::int64_t from,std::int64_t to,int sent,string extra="")
{return "{\"ok\":true,\"tf\":"+SNJQuote(SNBarsTfName(tf))+",\"summary\":{\"from_server\":"+IntegerToString(from)+",\"to_server\":"+IntegerToString(to)+",\"accepted\":"+IntegerToString(sent)+",\"dropped\":0,\"complete\":false,\"state\":\""+(sent>0?"have":"pending")+"\"}"+extra+"}";}
bool accepted(string reply,int tf,std::int64_t a,std::int64_t z,int count)
{return SNBarsAcknowledged(reply,tf,a,z,count,"key","1001","Synthetic-Demo","XAUUSD");}
int main(int argc,char** argv){try{
 string scenario=argc>1?argv[1]:"";CSyncNoteBars b;init(b);
 int tf,kind;std::int64_t from,to;
 if(scenario=="fair"){
  for(int i=0;i<4;i++){
   require(b.Next(NOW,tf,from,to,kind)&&tf==i&&kind==SNB_SCAN,"initial timeframes starved");
   require(from>=NOW-SNB_RECENT_SECONDS&&to<NOW,"request escaped recent closed bars");
   require((to-from)/SNBarsTfSeconds(tf)+1<=2000,"page exceeds 2000 rows");
   b.Failed(tf,kind,NOW);
  }
  require(!b.Next(NOW,tf,from,to,kind),"failed frame retries without cooldown");
 }
 else if(scenario=="bounded_empty"){
  int pages[4]={0,0,0,0},attempts=0;
  while(b.Next(NOW,tf,from,to,kind)){
   require(kind==SNB_SCAN,"unexpected initial work kind");pages[tf]++;attempts++;
   b.Acknowledged(tf,kind,from,NOW);require(attempts<20,"scan never completes");
  }
  require(b.InitialChecked(NOW),"initial bounded checking did not finish");
  require(pages[0]==6&&pages[1]==2&&pages[2]==1&&pages[3]==1,"wrong bounded scan depth");
  require(b.Gaps()==4,"empty read fabricated known closure");
  require(b.Tail(0)==0,"empty read advanced confirmed tail");
 }
 else if(scenario=="partial"){
  require(b.Next(NOW,tf,from,to,kind)&&tf==0,"missing initial frame");
  auto a=from+60,z=to-60;b.Confirm(tf,a,a);b.Confirm(tf,z,z);b.Acknowledged(tf,kind,from,NOW);
  require(b.Unconfirmed(tf,from)&&b.Unconfirmed(tf,from+120)&&b.Unconfirmed(tf,to),"partial rows erased prefix/interior/tail");
  require(!b.Unconfirmed(tf,a)&&!b.Unconfirmed(tf,z),"real rows not confirmed");
  require(b.Tail(tf)==z,"tail does not match actual row");
 }
 else if(scenario=="failed_ack"){
  require(b.Next(NOW,tf,from,to,kind),"missing work");auto cursor=b.ScanCursor(tf);
  require(!accepted("{\"ok\":true}",tf,from,to,2),"incomplete HTTP200 accepted");
  b.Failed(tf,kind,NOW);require(b.ScanCursor(tf)==cursor&&b.Tail(tf)==0&&b.Unconfirmed(tf,from),"failed ACK advanced evidence");
 }
 else if(scenario=="weekend"){
  while(b.Next(NOW,tf,from,to,kind))b.Acknowledged(tf,kind,from,NOW);
  auto later=NOW+3*86400;int seen[4]={0,0,0,0};
  for(int i=0;i<4;i++){
   require(b.Next(later,tf,from,to,kind)&&kind==SNB_DELTA,"old weekend gap blocked current delta");seen[tf]++;
   int p=SNBarsTfSeconds(tf);require(to==later/p*p-p&&from>=to-1999*p,"delta did not target current head");
   b.Confirm(tf,to-2*p,to);b.Acknowledged(tf,kind,from,later);
  }
  for(int i=0;i<4;i++)require(seen[i]==1,"delta unfair across timeframes");
  require(b.Gaps()>0,"new tail erased old weekend uncertainty");
 }
 else if(scenario=="repair"){
  while(b.Next(NOW,tf,from,to,kind))b.Acknowledged(tf,kind,from,NOW);
  auto later=NOW+600;std::int64_t first=0,second=0;int probes=0;
  for(int i=0;i<8;i++){
   require(b.Next(later,tf,from,to,kind),"missing delayed work");
   if(tf==0&&kind==SNB_REPAIR){first=to;probes++;}b.Acknowledged(tf,kind,from,later);
  }
  require(probes==1,"repair did not receive bounded turn");later+=600;
  for(int i=0;i<8;i++){
   require(b.Next(later,tf,from,to,kind),"missing second delayed work");
   if(tf==0&&kind==SNB_REPAIR){second=to;probes++;}b.Acknowledged(tf,kind,from,later);
  }
  require(probes==2&&second<first,"empty repair repeatedly probes same newest hole");
 }
 else if(scenario=="state"){
  b.Next(NOW,tf,from,to,kind);b.Confirm(tf,from+60,from+60);b.Acknowledged(tf,kind,from,NOW);
  string state=b.State();CSyncNoteBars copy;init(copy);require(copy.Load(state,NOW),"valid v2 state rejected");
  require(copy.ScanCursor(0)==b.ScanCursor(0)&&!copy.Unconfirmed(0,from+60)&&copy.Unconfirmed(0,from),"checkpoint lost evidence or gap");
  require(copy.Next(NOW,tf,from,to,kind)&&kind==SNB_DELTA,"reconnect did not prioritize fresh current tail");
  for(string field:{"scope","account","server","symbol"}){
   CSyncNoteBars changed;init(changed,NOW,field=="scope"?"other":"scope",field=="account"?"other":"1001",field=="server"?"other":"Synthetic-Demo",field=="symbol"?"other":"XAUUSD");
   require(!changed.Load(state,NOW),"checkpoint scope mismatch accepted");
  }
  require(!copy.Load("SYNCNOTE_BARS_1\nkey\n",NOW),"v1 deep history resumed");
  auto bad=state;bad[bad.size()-3]=bad[bad.size()-3]=='a'?'b':'a';require(!copy.Load(bad,NOW),"bad checksum accepted");
 }
 else if(scenario=="ack"){
  std::int64_t a=NOW-600,z=NOW-60;
  require(accepted(ack(0,a,z,2),0,a,z,2),"current response format rejected");
  require(accepted(ack(0,a,z,0),0,a,z,0),"empty pending ACK rejected");
  string identity=",\"account_key\":\"key\",\"account\":\"1001\",\"server\":\"Synthetic-Demo\",\"symbol\":\"XAUUSD\",\"source\":\"srv:Synthetic-Demo\"";
  require(accepted(ack(0,a,z,2,identity),0,a,z,2),"matching bound identity rejected");
  require(!accepted(ack(1,a,z,2),0,a,z,2)&&!accepted(ack(0,a+60,z,2),0,a,z,2)&&!accepted(ack(0,a,z,1),0,a,z,2),"wrong tf/range/count accepted");
  require(!accepted(ack(0,a,z,2,",\"account\":\"999\""),0,a,z,2),"wrong ACK account accepted");
  auto complete=ack(0,a,z,2);complete.replace(complete.find("false"),5,"true");require(!accepted(complete,0,a,z,2),"unproven complete ACK accepted");
  auto dropped=ack(0,a,z,2);auto at=dropped.find("\"dropped\":0");dropped.replace(at,11,"\"dropped\":1");require(!accepted(dropped,0,a,z,2),"dropped local row accepted");
 }
 else if(scenario=="overflow"){
  b.Next(NOW,tf,from,to,kind);for(int i=1;i<1200;i+=2)b.Confirm(tf,from+i*60,from+i*60);
  require(b.Gaps()<=SNB_GAP_LIMIT+3,"gap storage exceeds bound");
  for(int i=0;i<1200;i+=2)require(b.Unconfirmed(tf,from+i*60),"fragment overflow erased an unconfirmed minute");
 }
 else throw std::runtime_error("unknown scenario");
 std::cout<<"passed "<<scenario;return 0;
}catch(const std::exception& e){std::cerr<<e.what();return 1;}}
'''

class SyncNoteBarRuntime(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  command,environment,msvc=compiler_environment()
  cls.folder=tempfile.TemporaryDirectory(prefix='syncnote-bars-runtime-');cls.addClassCleanup(cls.folder.cleanup)
  folder=Path(cls.folder.name);source=folder/'bars.cpp';cls.exe=folder/('bars.exe' if os.name=='nt' else 'bars')
  runtime=(ROOT/'tests/cpp/history_runtime.hpp').read_text(encoding='utf-8')
  # Hash API compatibility only: checkpoint logic uses the production emitter/parser.
  runtime=re.sub(r'int CryptEncode\([^\n]+',r'int CryptEncode(int,const std::vector<uchar>& bytes,const std::vector<uchar>&,std::vector<uchar>& out){out.assign(32,0);for(std::size_t i=0;i<bytes.size();i++)out[i%32]=static_cast<uchar>(out[i%32]*33+bytes[i]);return 32;}',runtime)
  text=runtime+'\n#define SYNCNOTE_BARS_CORE_ONLY\n'
  for name in ('SyncNoteJson.mqh','SyncNoteBars.mqh'):text+=cpp_source((ROOT/'bridge'/name).read_text(encoding='utf-8-sig'))+'\n'
  source.write_text(text+SCENARIOS,encoding='utf-8')
  command+=([str(source),'/Fe:'+str(cls.exe),'/Fo:'+str(folder/'bars.obj')] if msvc else [str(source),'-o',str(cls.exe)])
  result=subprocess.run(command,env=environment,cwd=folder,capture_output=True,text=True,timeout=90)
  if result.returncode:raise AssertionError('Actual SyncNote bar core compatibility compilation failed:\n'+result.stdout+'\n'+result.stderr)

 def scenario(self,name):
  result=subprocess.run([str(self.exe),name],capture_output=True,text=True,timeout=15)
  self.assertEqual(result.returncode,0,result.stdout+'\n'+result.stderr)

 def test_four_timeframes_fair_even_when_reads_fail(self):self.scenario('fair')
 def test_empty_initial_scan_bounded_but_never_claims_complete(self):self.scenario('bounded_empty')
 def test_partial_prefix_internal_and_tail_remain_unconfirmed(self):self.scenario('partial')
 def test_failed_ack_never_advances_progress(self):self.scenario('failed_ack')
 def test_old_weekend_gaps_do_not_block_fresh_delta(self):self.scenario('weekend')
 def test_empty_repair_rotates_segments_with_cooldown(self):self.scenario('repair')
 def test_v2_state_identity_symbol_scope_and_v1_rejection(self):self.scenario('state')
 def test_strict_ack_validates_existing_and_extended_response(self):self.scenario('ack')
 def test_fragment_overflow_stays_conservative(self):self.scenario('overflow')

if __name__=='__main__':unittest.main()
