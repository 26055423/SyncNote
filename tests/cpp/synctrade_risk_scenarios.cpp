std::unique_ptr<CSyncTradeRisk> opened(){auto r=std::make_unique<CSyncTradeRisk>();string error;require(r->Open(IntegerToString(login),server,error),error.c_str());require(r->Healthy(),"open must be healthy");return r;}
int main(int argc,char** argv){try{
 require(argc==2,"scenario required");string scenario=argv[1],error;auto risk=opened();auto day=broker_now/86400;
 if(scenario=="loss_entries"){
  deals={{1,DEAL_TYPE_BUY,DEAL_ENTRY_INOUT,"XAUUSD",-101}};
  require(!risk->LossAllowed("XAUUSD",100,error),"INOUT loss escaped");
  deals[0].entry=DEAL_ENTRY_OUT_BY;require(!risk->LossAllowed("XAUUSD",100,error),"OUT_BY loss escaped");
  deals[0].entry=DEAL_ENTRY_OUT;require(!risk->LossAllowed("XAUUSD",100,error),"OUT loss escaped");
  deals[0].entry=DEAL_ENTRY_IN;deals[0].profit=0;deals[0].commission=-60;deals[0].fee=-40;
  require(!risk->LossAllowed("XAUUSD",100,error),"IN entry cost/fee escaped at boundary");
  deals[0].commission=-20;deals[0].fee=-10;require(risk->LossAllowed("XAUUSD",100,error),"below-cap costs rejected");
  deals[0].profit=-60;deals[0].swap=-10;require(!risk->LossAllowed("XAUUSD",100,error),"profit/swap/cost aggregation wrong");
 }else if(scenario=="loss_scope"){
  deals={{1,DEAL_TYPE_BUY,DEAL_ENTRY_OUT,"XAUUSD",-110},{2,DEAL_TYPE_BALANCE,DEAL_ENTRY_IN,"XAUUSD",10000}};
  require(!risk->LossAllowed("XAUUSD",100,error),"Deposit erased trading loss");
  deals[0].symbol="EURUSD";require(risk->LossAllowed("XAUUSD",100,error),"Other-symbol loss entered scope");
  deals.push_back({3,DEAL_TYPE_COMMISSION,DEAL_ENTRY_IN,"XAUUSD",-100});
  require(!risk->LossAllowed("XAUUSD",100,error),"Symbol commission ignored");
  deals.back().symbol="";require(risk->LossAllowed("XAUUSD",100,error),"Unassigned account fee guessed into symbol");
 }else if(scenario=="loss_failures"){
  deals={{1,DEAL_TYPE_BUY,DEAL_ENTRY_OUT,"XAUUSD",-10}};fail_select=true;
  require(!risk->LossAllowed("XAUUSD",100,error),"Failed select allowed trade");
  require(risk->LossAllowed("XAUUSD",0,error),"Disabled cap queried history");fail_select=false;
  fail_ticket_index=0;require(!risk->LossAllowed("XAUUSD",100,error),"Missing ticket skipped");fail_ticket_index=-1;
  for(int p:{DEAL_TYPE,DEAL_SYMBOL,DEAL_TIME,DEAL_ENTRY,DEAL_PROFIT,DEAL_SWAP,DEAL_COMMISSION,DEAL_FEE}){fail_property=p;require(!risk->LossAllowed("XAUUSD",100,error),"Failed getter allowed trade");}fail_property=-1;
  deals[0].fee=std::numeric_limits<double>::quiet_NaN();require(!risk->LossAllowed("XAUUSD",100,error),"Nonfinite amount accepted");
  require(!risk->LossAllowed("XAUUSD",-1,error),"Negative cap disabled guard");
 }else if(scenario=="metadata_failures"){
  fail_count=true;require(!risk->LossAllowed("XAUUSD",100,error),"History count failure accepted as empty history");fail_count=false;
  fail_tell=true;require(!risk->Reserve("command_001",day,2,error)&&!risk->Healthy(),"FileTell failure allowed reserve");fail_tell=false;risk->Close();
  require(risk->Open(IntegerToString(login),server,error),"reopen after tell failure failed");
  fail_size=true;require(!risk->Reserve("command_002",day,2,error)&&!risk->Healthy(),"FileSize failure allowed reserve");fail_size=false;risk->Close();
  fail_size=true;require(!risk->Open(IntegerToString(login),server,error),"FileSize error treated as a new empty journal");fail_size=false;risk->Close();
  require(risk->Open(IntegerToString(login),server,error),"healthy file did not reopen");
  fail_seek=true;require(!risk->Reserve("command_003",day,2,error)&&!risk->Healthy(),"FileSeek failure allowed reserve");
 }else if(scenario=="quota_restart"){
  require(risk->Reserve("command_001",day,1,error),"first reserve failed");
  require(!risk->Reserve("command_001",day,1,error),"Same id authorized another send");
  require(!risk->Reserve("command_002",day,1,error),"quota exceeded");
  risk->Close();require(risk->Open(IntegerToString(login),server,error),"restart failed");
  require(risk->Reserved(day)==1,"restart lost unknown-result reservation");
  require(!risk->Reserve("command_002",day,1,error),"restart reset quota");
  require(!risk->Reserve("command_001",day,1,error),"crash gap replay allowed");
 }else if(scenario=="quota_release_day"){
  require(risk->Reserve("command_001",day,1,error),"reserve failed");
  require(risk->Release("command_001",error),"unsent release failed");
  require(risk->Release("command_001",error),"release not idempotent");
  require(risk->Reserve("command_002",day,1,error),"released slot unavailable");
  require(!risk->Reserve("command_001",day,5,error),"released id reused");
  broker_now+=86400;require(!risk->Reserve("command_003",day,1,error),"caller forged day");
  require(risk->Reserve("command_003",day+1,1,error),"new-day slot unavailable");
  risk->Close();require(risk->Open(IntegerToString(login),server,error),"reopen failed");
  require(risk->Reserved(day)==1&&risk->Reserved(day+1)==1,"day counts corrupted");
 }else if(scenario=="quota_accounts_lock"){
  require(risk->Reserve("command_001",day,1,error),"reserve failed");
  auto second=std::make_unique<CSyncTradeRisk>();require(!second->Open(IntegerToString(login),server,error),"second writer got lock");second->Close();
  risk->Close();login=2002;require(risk->Open(IntegerToString(login),server,error),"switch account failed");
  require(risk->Reserved(day)==0,"other account inherited quota");
  require(risk->Reserve("command_001",day,1,error),"other account id wrongly collided");
  risk->Close();login=1001;require(risk->Open(IntegerToString(login),server,error),"restore account failed");
  require(risk->Reserved(day)==1,"first account quota lost");
  server="Other-Broker";require(!risk->Healthy()&&!risk->Reserve("command_004",day,1,error),"server change retained authorization");
  require(risk->Open(IntegerToString(login),server,error)&&risk->Reserved(day)==0,"server quota not isolated");
 }else if(scenario=="quota_account_switch_release"){
  require(risk->Reserve("command_001",day,1,error),"old account reserve failed");
  login=2002;
  require(!risk->Healthy(),"switched account reported healthy");
  require(!risk->Reserve("command_002",day,1,error),"switched account received reserve authorization");
  require(!risk->LossAllowed("XAUUSD",0,error),"switched account passed loss guard");
  require(!risk->Release("unknown_001",error),"unknown id released from old ledger");
  require(risk->Release("command_001",error),"confirmed-unsent old reservation could not be released");
  require(!risk->Healthy(),"cleanup authorized new account activity");
  risk->Close();login=1001;
  require(risk->Open(IntegerToString(login),server,error),"old account reopen failed");
  require(risk->Reserved(day)==0,"old account unsent slot remained consumed after restart");
  require(risk->Reserve("command_003",day,1,error),"released old account slot unavailable");
 }else if(scenario=="journal_corruption"){
  require(risk->Reserve("command_001",day,1,error),"reserve failed");string path=last_path;risk->Close();string original=disk[path].bytes;
  disk[path].bytes.back()='x';require(!risk->Open(IntegerToString(login),server,error)&&!risk->Healthy(),"truncated row accepted");risk->Close();
  disk[path].bytes=original;disk[path].bytes[disk[path].bytes.size()-4]^=1;require(!risk->Open(IntegerToString(login),server,error),"checksum corruption accepted");risk->Close();
  disk[path].bytes=original;fail_read=true;require(!risk->Open(IntegerToString(login),server,error),"read failure accepted");fail_read=false;risk->Close();
  disk[path].bytes=original;require(risk->Open(IntegerToString(login),server,error),"valid journal no longer reads");
 }else if(scenario=="journal_write_failures"){
  fail_write=true;require(!risk->Reserve("command_001",day,2,error)&&!risk->Healthy(),"partial write allowed send");fail_write=false;
  require(!risk->Reserve("command_002",day,2,error),"write failure did not poison guard");string path=last_path;risk->Close();
  require(!risk->Open(IntegerToString(login),server,error),"partial tail did not fail closed after restart");risk->Close();disk[path].bytes.clear();require(risk->Open(IntegerToString(login),server,error),"new file failed");
  fail_flush=true;require(!risk->Reserve("command_003",day,2,error)&&!risk->Healthy(),"flush failure allowed send");fail_flush=false;risk->Close();
  require(risk->Open(IntegerToString(login),server,error)&&risk->Reserved(day)==1,"uncertain durable write was forgotten");
  fail_flush=true;require(!risk->Release("command_003",error)&&!risk->Healthy(),"release flush failure allowed more trading");
 }else throw std::runtime_error("unknown scenario");
 std::cout<<"Risk production module scenario passed: "<<scenario<<"\n";
}catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}return 0;}
