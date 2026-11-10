"""Execute production pairing/button lifecycle with generated peers, no broker IO."""
import re,subprocess,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_ea_history import compiler_environment,cpp_source
from test_synctrade_commands import function
ROOT=Path(__file__).resolve().parents[1]

class PairingLifecycleTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  source=(ROOT/'bridge/SyncTrade.mq5').read_text(encoding='utf-8-sig')
  functions='\n'.join(cpp_source(function(source,name)) for name in ('HasActiveSession','HasPendingPairing','PaintStatus','LocalClosed','UpdatePairingState','OnChartEvent'))
  cls.temp=tempfile.TemporaryDirectory(prefix='synctrade-pairing-');cls.addClassCleanup(cls.temp.cleanup)
  folder=Path(cls.temp.name);path=folder/'pairing.cpp';cls.exe=folder/'pairing.exe'
  path.write_text(r'''
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <set>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>
using string=std::string;using uint=unsigned int;
constexpr int LOCAL_PEERS=4,CHARTEVENT_OBJECT_CLICK=1,OBJPROP_STATE=1;
constexpr std::uint64_t WIN_INVALID_SOCKET=~std::uint64_t(0),PAIR_TTL_MS=120000;
#define LOCAL_VERSION string("test")
template<class A,class B> auto MathMax(A a,B b){using C=std::common_type_t<A,B>;return std::max(C(a),C(b));}
template<class A,class B> auto MathMin(A a,B b){using C=std::common_type_t<A,B>;return std::min(C(a),C(b));}
double MathRound(double n){return std::round(n);} string IntegerToString(std::int64_t n){return std::to_string(n);}
std::uint64_t tick=1000,g_pending_until=0,g_pair_until=121000,g_last_bar=0;
string g_token="",g_pair_code="12345678",g_account="synthetic",g_server="Demo",g_button_allow="Allow",g_button_revoke="Revoke";
string InpAllowedOrigin="https://example.test",InpSymbol="XAUUSD",g_symbol="XAUUSD";
int InpPanelScale=200,g_panel_button_y=0,g_pending_peer=-1,g_session_peer=-1;
int codes=0,tokens=0,clears=0,snapshots=0,rejections=0;bool g_bar_dirty=false,g_journal_ok=true,g_risk_ok=true,account_changed=false;
struct Peer {std::uint64_t handle=WIN_INVALID_SOCKET,seen_ms=0;bool upgraded=false,authenticated=false,closing=false;} g_local_peers[LOCAL_PEERS];
struct Job{bool active=false;int peer=-1;} g_bars_job,g_history_job;
struct Export{void Reset(){}} g_history_export;
std::set<string> buttons;std::vector<string> labels;
std::uint64_t GetTickCount64(){return tick;}
bool NewPairCode(){codes++;g_pair_code="87654321";g_pair_until=tick+PAIR_TTL_MS;return true;}
void ClearAuthorization(){clears++;g_token="";g_pending_peer=g_session_peer=-1;g_pending_until=0;for(auto& p:g_local_peers)p.authenticated=false;}
void AccountChanged(){if(account_changed){account_changed=false;ClearAuthorization();NewPairCode();}}
bool LocalCanTrade(){return true;} string BlockReason(){return "";}
void PanelBackground(int n){labels.resize(n);} void PanelLabel(int i,const string& text){labels[i]=text;}
int PanelHeightFor(int n){return n*20;} void MakeButton(const string& name,const string&,int){buttons.insert(name);}
void ObjectDelete(int,const string& name){buttons.erase(name);} void ObjectSetInteger(int,const string&,int,bool){}
void ChartRedraw(){} template<class...T>void Print(T...){}
void Comment(const string&){}
void LocalError(int,const string&,const string&){rejections++;}
string RandomHex(int){tokens++;return "generated-session-"+std::to_string(tokens);}
string JStr(const string& s){return "\""+s+"\"";} string IdentityFields(){return "\"synthetic\":true";}
void WsText(int,const string&){} void SendSnapshot(int){snapshots++;}
void check(bool value,const char* why){if(!value)throw std::runtime_error(why);}
void pending(){g_local_peers[0]={1,tick,true,false,false};g_pending_peer=0;g_pending_until=tick+60000;}
void active(){pending();g_pending_peer=-1;g_token="existing-session";g_session_peer=0;g_local_peers[0].authenticated=true;}
''' +functions+r'''
int main(int argc,char**argv){try{
 string scenario=argc>1?argv[1]:"";
 if(scenario=="idle_click"){
  PaintStatus();check(!buttons.count("Allow")&&!buttons.count("Revoke"),"idle has no authorization buttons");
  OnChartEvent(1,0,0,"Allow");check(codes==0&&tokens==0&&g_pair_code=="12345678","idle click cannot rotate code");
 }else if(scenario=="approve_once"){
  pending();PaintStatus();check(buttons.count("Allow"),"only pending request exposes Allow");
  OnChartEvent(1,0,0,"Allow");string token=g_token;
  check(HasActiveSession()&&!buttons.count("Allow")&&buttons.count("Revoke"),"approval hides Allow and keeps Revoke");
  OnChartEvent(1,0,0,"Allow");check(tokens==1&&g_token==token&&codes==0,"queued double-click must be inert");
 }else if(scenario=="live_ttl"){
  active();g_pair_until=0;tick+=130000;g_local_peers[0].seen_ms=tick;UpdatePairingState();
  check(codes==0&&g_token=="existing-session","pairing TTL never rotates a live session");
 }else if(scenario=="closed"){
  active();g_local_peers[0]=Peer{};LocalClosed(0);
  check(g_token==""&&g_session_peer==-1&&codes==1&&!buttons.count("Allow"),"closed receiver resets to idle");
  pending();PaintStatus();check(buttons.count("Allow"),"only a fresh request restores Allow");
 }else if(scenario=="silent"){
  active();tick+=90001;UpdatePairingState();check(g_token==""&&clears==1&&codes==1,"lost heartbeats revoke stale session");
 }else if(scenario=="closing"){
  active();g_local_peers[0].closing=true;UpdatePairingState();check(g_token==""&&codes==1,"closing socket is not a receiver");
 }else if(scenario=="pending_expired"){
  pending();tick+=60001;UpdatePairingState();OnChartEvent(1,0,0,"Allow");
  check(g_pending_peer==-1&&g_token==""&&tokens==0&&codes==1&&!buttons.count("Allow"),"expired approval cannot authorize");
 }else if(scenario=="pending_closed"){
  pending();g_local_peers[0]=Peer{};LocalClosed(0);check(g_pending_peer==-1&&!buttons.count("Allow"),"closed requester hides Allow");
 }else if(scenario=="reject"){
  pending();OnChartEvent(1,0,0,"Revoke");check(rejections==1&&tokens==0&&g_token==""&&!buttons.count("Allow"),"reject never issues a token");
 }else if(scenario=="account_change"){
  pending();account_changed=true;OnChartEvent(1,0,0,"Allow");check(tokens==0&&g_token=="","account switch invalidates pending consent");
 }else throw std::runtime_error("unknown scenario");
 std::cout<<"ok";return 0;
 }catch(const std::exception&e){std::cerr<<e.what();return 1;}}
''',encoding='utf-8')
  command,env,msvc=compiler_environment()
  command+=([str(path),'/Fe:'+str(cls.exe),'/Fo:'+str(folder/'pairing.obj')] if msvc else [str(path),'-o',str(cls.exe)])
  result=subprocess.run(command,env=env,cwd=folder,capture_output=True,text=True)
  if result.returncode:raise AssertionError(result.stdout+result.stderr)
 def scenario(self,name):
  result=subprocess.run([str(self.exe),name],capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr)
 def test_idle_allow_is_hidden_and_inert(self):self.scenario('idle_click')
 def test_approval_and_double_click(self):self.scenario('approve_once')
 def test_live_session_has_no_pair_code_expiry(self):self.scenario('live_ttl')
 def test_receiver_closed(self):self.scenario('closed')
 def test_receiver_heartbeat_timeout(self):self.scenario('silent')
 def test_receiver_closing(self):self.scenario('closing')
 def test_pending_timeout(self):self.scenario('pending_expired')
 def test_pending_requester_closed(self):self.scenario('pending_closed')
 def test_local_rejection(self):self.scenario('reject')
 def test_account_change_invalidates_consent(self):self.scenario('account_change')

if __name__=='__main__':unittest.main()
