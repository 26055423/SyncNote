"""Execute production SyncNote symbol catalog scheduler with deterministic MT5/HTTP doubles."""
import subprocess,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_ea_history import compiler_environment,cpp_source
ROOT=Path(__file__).resolve().parents[1]

class SyncNoteSymbolsTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  source=cpp_source((ROOT/'bridge/SyncNoteSymbols.mqh').read_text(encoding='utf-8-sig'))
  command,env,msvc=compiler_environment()
  cls.temp=tempfile.TemporaryDirectory(prefix='syncnote-symbols-');cls.addClassCleanup(cls.temp.cleanup)
  folder=Path(cls.temp.name);path=folder/'symbols.cpp';cls.exe=folder/'symbols.exe'
  path.write_text(r'''
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
using string=std::string;using ulong=std::uint64_t;
template<class A,class B> auto MathMin(A a,B b){return std::min<decltype(a+b)>(a,b);}
template<class A,class B> auto MathMax(A a,B b){return std::max<decltype(a+b)>(a,b);}
template<class T> int ArrayResize(std::vector<T>& x,int n){x.resize(n);return n;}
template<class T> string IntegerToString(T n){return std::to_string(n);}
int StringLen(string s){return (int)s.size();}
string StringSubstr(string s,int a,int n){return s.substr(a,n);}
string SNJQuote(string s){return "\""+s+"\"";}
string SNJHash(string s){return "catalog-"+s;}
bool SNJTop(const string& s,const string& k,string& out){auto at=s.find("\""+k+"\":");if(at==string::npos)return false;at+=k.size()+3;if(s[at]=='\"'){auto end=s.find('"',at+1);out=s.substr(at,end-at+1);}else{auto end=s.find_first_of(",}",at);out=s.substr(at,end-at);}return true;}
bool SNJTopString(string s,string k,string& out){string raw;if(!SNJTop(s,k,raw)||raw.size()<2||raw[0]!='"')return false;out=raw.substr(1,raw.size()-2);return true;}
bool SNJSignedPositive(string s,std::int64_t& out){try{std::size_t n;out=std::stoll(s,&n);return n==s.size()&&out>=0;}catch(...){return false;}}
ulong tick=10000;ulong GetTickCount64(){return tick;}long TimeLocal(){return 1700000000;}
string g_sn_token="authorized",g_sn_account="123",g_sn_server="Broker",g_sn_key="account",g_sn_sync_scope="scope";
int g_sn_ack_batches=1,total=205,posts=0,pauses=0,response=0;bool bound=true,change_in_post=false,metadata=true;
std::vector<string> bodies;
bool SNStillBound(){return bound;}
void SNPause(string){pauses++;}
int SymbolsTotal(bool selected){if(selected)throw std::runtime_error("must enumerate broker universe");return total;}
string SymbolName(int i,bool selected){if(selected)throw std::runtime_error("must not use Market Watch");return "SYM"+std::to_string(i);}
enum {SYMBOL_DESCRIPTION,SYMBOL_PATH,SYMBOL_TRADE_MODE,SYMBOL_DIGITS};
bool SymbolInfoString(string,int property,string& value){value=property==SYMBOL_DESCRIPTION?"Description":"Indices";return metadata;}
bool SymbolInfoInteger(string,int property,std::int64_t& value){value=property==SYMBOL_DIGITS?2:4;return metadata;}
int SNPost(string endpoint,string body,string& reply);
''' +source+r'''
int SNPost(string endpoint,string body,string& reply){
 if(endpoint!="/api/mt5/symbols-sync")throw std::runtime_error("wrong endpoint");posts++;bodies.push_back(body);
 if(change_in_post)bound=false;
 if(response==500)return 500;
 reply="{\"ok\":true,\"account_key\":\"account\",\"catalog_id\":"+SNJQuote(g_sns_id)+",\"offset\":"+IntegerToString(g_sns_offset)+",\"next_offset\":"+IntegerToString(g_sns_offset+g_sns_count+(response==1?1:0))+",\"total\":"+IntegerToString(g_sns_total)+",\"complete\":"+(g_sns_offset+g_sns_count==g_sns_total?"true":"false")+"}";
 return 200;
}
void check(bool ok,const char* why){if(!ok)throw std::runtime_error(why);}
void prepare(){for(int i=0;i<3;i++){SNSymbolsPump();tick+=400;}}
int main(int argc,char** argv){try{
 string scenario=argc>1?argv[1]:"";
 if(scenario=="authorization"){
  g_sn_token="";check(!SNSymbolsPump()&&posts==0,"unpaired upload");g_sn_token="token";g_sn_ack_batches=0;check(!SNSymbolsPump()&&posts==0,"unbound upload");
 }else if(scenario=="paging"){
  prepare();check(g_sns_scan==205&&posts==0,"bounded capture must finish before upload");
  SNSymbolsPump();check(posts==1&&g_sns_offset==100,"first page");tick+=3000;SNSymbolsPump();check(posts==2&&g_sns_offset==200,"second page");tick+=3000;SNSymbolsPump();check(posts==3&&!g_sns_active&&g_sns_offset==205,"final page");
  check(bodies[0].find("\"symbol\":\"SYM0\"")!=string::npos&&bodies[2].find("\"symbol\":\"SYM204\"")!=string::npos,"exact raw symbols");
  tick+=3599999;check(!SNSymbolsPump()&&posts==3,"hourly refresh too soon");
 }else if(scenario=="retry"){
  prepare();response=1;SNSymbolsPump();check(g_sns_offset==0&&posts==1,"forged ACK advances");string pending=g_sns_pending;tick=g_sns_next;response=500;SNSymbolsPump();check(g_sns_offset==0&&g_sns_pending==pending&&bodies[0]==bodies[1],"retry body changed");tick=g_sns_next;response=0;SNSymbolsPump();check(g_sns_offset==100&&g_sns_pending=="","valid ACK does not advance");
 }else if(scenario=="account_change"){
  prepare();change_in_post=true;SNSymbolsPump();check(pauses==1&&g_sns_offset==0,"account changed during upload");
 }else if(scenario=="changed_directory"){
  SNSymbolsPump();tick+=400;total=206;SNSymbolsPump();check(posts==0&&!g_sns_active,"inconsistent name capture published");
 }else if(scenario=="metadata_failure"){
  prepare();metadata=false;SNSymbolsPump();check(posts==1&&g_sns_offset==100,"missing optional metadata must not hide broker codes");check(bodies[0].find("\"symbol\":\"SYM0\"")!=string::npos,"raw symbol missing");
 }else throw std::runtime_error("unknown scenario");
 std::cout<<"ok";return 0;
 }catch(const std::exception& e){std::cerr<<e.what();return 1;}}
''',encoding='utf-8')
  command+=([str(path),'/Fe:'+str(cls.exe),'/Fo:'+str(folder/'symbols.obj')] if msvc else [str(path),'-o',str(cls.exe)])
  result=subprocess.run(command,env=env,cwd=folder,capture_output=True,text=True)
  if result.returncode:raise AssertionError(result.stdout+result.stderr)
 def scenario(self,name):
  result=subprocess.run([str(self.exe),name],capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr)
  self.assertEqual(result.stdout,'ok')
 def test_authorization_before_metadata(self):self.scenario('authorization')
 def test_bounded_pages_and_hourly_refresh(self):self.scenario('paging')
 def test_exact_ack_and_same_page_retries(self):self.scenario('retry')
 def test_account_change_during_request(self):self.scenario('account_change')
 def test_changed_directory_restarts_snapshot(self):self.scenario('changed_directory')
 def test_unselected_symbols_keep_codes_without_optional_metadata(self):self.scenario('metadata_failure')

if __name__=='__main__':unittest.main()
