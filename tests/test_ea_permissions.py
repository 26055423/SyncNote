"""Execute the EA's account/quota gates with synthetic broker and journal state."""
import json,os,re,subprocess,tempfile,unittest
from pathlib import Path
from test_ea_history import compiler_environment,cpp_source

ROOT=Path(__file__).resolve().parents[1]

def function(source,name):
 match=re.search(r'^(?:bool|string) '+name+r'\([^\n]*\)\s*\{',source,re.M)
 if not match:raise AssertionError('Missing production function: '+name)
 depth=1;end=match.end()
 while depth:
  depth+=(source[end]=='{')-(source[end]=='}');end+=1
 return source[match.start():end]

class AccountQuotaPermissions(unittest.TestCase):
 def test_real_account_without_legacy_optins_and_quotas(self):
  mql=(ROOT/'bridge/SyncTrade.mq5').read_text(encoding='utf-8-sig')
  inputs='\n'.join(kind+' '+name+'='+value+';' for kind,name,value in re.findall(r'^input (bool|int|long|double) (\w+)=([^;]+);',mql,re.M))
  policy=re.search(r'^#define LOCAL_NO_QUOTAS [^\n]+',mql,re.M).group(0)
  runtime=r'''
#include <string>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <iostream>
using string=std::string;
const int ACCOUNT_MARGIN_MODE=1,ACCOUNT_MARGIN_MODE_RETAIL_HEDGING=2,ACCOUNT_MARGIN_MODE_RETAIL_NETTING=3,ACCOUNT_MARGIN_MODE_EXCHANGE=4;
const int SYMBOL_VOLUME_MIN=1,SYMBOL_VOLUME_MAX=2,SYMBOL_VOLUME_STEP=3;
int margin=ACCOUNT_MARGIN_MODE_RETAIL_NETTING;
long AccountInfoInteger(int){return margin;}
bool LocalDemo(){return false;} bool LocalReal(){return true;}
bool LocalHedging(){return margin==ACCOUNT_MARGIN_MODE_RETAIL_HEDGING;}
bool g_journal_ok=true,g_account_stable=true,g_risk_ok=true;
struct Risk { bool healthy=true;int losses=0;bool Healthy(){return healthy;} bool LossAllowed(string,double,string&){losses++;return false;} } g_risk;
bool netting_allowed=false;int netting_checks=0,exposure_checks=0;
bool NettingOrderAllowed(string,string& error){netting_checks++;if(!netting_allowed)error="netting consent";return netting_allowed;}
bool ExposureAllowed(double,string&){exposure_checks++;return false;}
bool NewOrderAction(string action){return action=="market"||action=="limit"||action=="stop";}
double SymbolInfoDouble(string,int prop){return prop==SYMBOL_VOLUME_MIN?0.01:prop==SYMBOL_VOLUME_MAX?50.0:0.01;}
bool MathIsValidNumber(double n){return std::isfinite(n);} double MathRound(double n){return std::round(n);} double MathAbs(double n){return std::abs(n);}
string InpSymbol="XAUUSD";
string g_instance="fixture",g_account="123",g_server="Fixture-Broker",g_epoch="epoch";
string JStr(string value){return "\""+value+"\"";}
string HashHex(string){return "fixture-hash";} string IntegerToString(std::int64_t n){return std::to_string(n);}
std::int64_t TimeTradeServer(){return 1700000000;} std::int64_t TimeGMT(){return 1700000000;}
void require(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
'''
  scenarios=r'''
int main(){try{
 InpAllowTrading=false;InpAllowRealTrading=false;InpRealMaxLots=0;InpRealMaxOrdersPerDay=0;InpUnrestricted=false;
 require(LocalCanTrade()&&BlockReason().empty(),"Real account still requires legacy opt-ins or quotas");
 g_journal_ok=false;require(!LocalCanTrade()&&BlockReason()=="journal","Journal failure bypassed");g_journal_ok=true;
 g_account_stable=false;require(!LocalCanTrade()&&BlockReason()=="account","Unstable account bypassed");g_account_stable=true;
 g_risk.healthy=false;require(!LocalCanTrade()&&BlockReason()=="risk","Unhealthy ledger bypassed");g_risk.healthy=true;
 margin=-1;require(!LocalCanTrade()&&BlockReason()=="margin_mode","Unknown margin mode accepted");margin=ACCOUNT_MARGIN_MODE_RETAIL_NETTING;
 require(!LocalManageAllowed(),"Quota mode granted netting management");
 require(VolumeValid(10.0),"Local volume cap still applied");
 require(!VolumeValid(60.0)&&!VolumeValid(0.015)&&!VolumeValid(-1),"Broker volume rules bypassed");
 string error;
 require(!OpeningAllowed("market",10,error)&&netting_checks==1,"Quota mode bypassed netting consent");
 netting_allowed=true;require(OpeningAllowed("market",10,error),"Local exposure/daily quota still applied");
 require(netting_checks==2&&exposure_checks==0&&g_risk.losses==0,"Quota bypass affected wrong gates");
 std::cout<<"Account/quota production gates passed\n{"<<IdentityFields()<<"}";return 0;
}catch(const std::exception& e){std::cerr<<e.what();return 1;}}
'''
  gates='\n'.join(function(mql,name) for name in ('LocalManageAllowed','LocalCanTrade','BlockReason','VolumeValid','OpeningAllowed','JsonBool','CapabilitiesJson','IdentityFields'))
  command,environment,msvc=compiler_environment()
  with tempfile.TemporaryDirectory(prefix='synctrade-permissions-') as folder:
   path=Path(folder);source=path/'permissions.cpp';exe=path/('permissions.exe' if os.name=='nt' else 'permissions')
   source.write_text(runtime+'\n'+cpp_source(inputs+'\n'+policy+'\n'+gates)+'\n'+scenarios,encoding='utf-8')
   command+=([str(source),'/Fe:'+str(exe),'/Fo:'+str(path/'permissions.obj')] if msvc else [str(source),'-o',str(exe)])
   result=subprocess.run(command,env=environment,cwd=folder,capture_output=True,text=True,timeout=90)
   self.assertEqual(result.returncode,0,result.stdout+result.stderr)
   result=subprocess.run([str(exe)],capture_output=True,text=True,timeout=30)
   self.assertEqual(result.returncode,0,result.stdout+result.stderr)
   self.assertIn('Account/quota production gates passed',result.stdout)
   identity=json.loads(result.stdout.split('\n',1)[1])
   self.assertIs(identity['quota_unrestricted'],True)
   self.assertIs(identity['unrestricted'],False)
   self.assertIs(identity['real_trading'],True)
   self.assertIs(identity['read_only'],False)
   self.assertEqual(identity['block_reason'],'')

if __name__=='__main__':unittest.main()
