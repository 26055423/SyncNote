bool fake_risk_healthy=true,fake_loss_allowed=true,fake_reserve_ok=true,fake_release_ok=true;
int fake_reserved=0;
class CSyncTradeRisk{
 public:
 bool Open(const string&,const string&,string& error){fake_events.push_back("risk:open");if(!fake_risk_healthy)error="Synthetic risk ledger unavailable";return fake_risk_healthy;}
 void Close(){}
 bool Healthy(){return fake_risk_healthy;}
 bool LossAllowed(const string&,double cap,string& error){fake_events.push_back("risk:loss");if(!fake_risk_healthy||(cap>0&&!fake_loss_allowed)){error="Synthetic daily loss lookup denied";return false;}return true;}
 bool Reserve(const string&,std::int64_t,int cap,string& error){fake_events.push_back("risk:reserve");if(!fake_risk_healthy||!fake_reserve_ok||fake_reserved>=cap){error="Synthetic reservation refused";return false;}fake_reserved++;return true;}
 bool Release(const string&,string& error){fake_events.push_back("risk:release");if(!fake_release_ok){fake_risk_healthy=false;error="Synthetic release failed";return false;}if(fake_reserved>0)fake_reserved--;return true;}
 int Reserved(std::int64_t){return fake_reserved;}
};
CSyncTradeRisk g_risk;
string CommandResult(const string& id,const string& state,const string& error,uint code=0,std::uint64_t order=0,std::uint64_t deal=0,double price=0,double volume=0){
 return "{\"command_id\":"+JStr(id)+",\"state\":"+JStr(state)+",\"error\":"+JStr(error)+",\"retcode\":"+IntegerToString(code)+",\"order\":"+JStr(IntegerToString(order))+",\"deal\":"+JStr(IntegerToString(deal))+",\"price\":"+JNum(price,8)+",\"volume\":"+JNum(volume,8)+"}";
}
void LocalError(int,const string& code,const string& message){fake_reply="{\"state\":\"rejected\",\"error\":"+JStr(code+": "+message)+"}";}
