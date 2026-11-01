constexpr std::int64_t START=1700000000;
void Fixture(const string& name){
 if(name=="same_second"){
  for(int i=149;i>=0;i--)fake_deals.push_back({9007199254740993ULL+static_cast<std::uint64_t>(i),0,0,START*1000+100,2,0});
 }else if(name=="many_positions"){
  for(int i=0;i<4;i++){auto p=static_cast<std::uint64_t>(5001+i);fake_deals.push_back({static_cast<std::uint64_t>(510+i*2),p,p,(START+1+i)*1000,0,0});fake_deals.push_back({static_cast<std::uint64_t>(511+i*2),p,p,(START+61+i)*1000,1,1,2410,.1,100});}
 }else{
  fake_deals.push_back({502,5001,5001,(START+61)*1000,1,1,2410,.1,100});
  fake_deals.push_back({501,5001,5001,(START+(name=="outside"?-86400:1))*1000,0,0});
  if(name=="unavailable")fake_missing_positions.insert(5001);
  if(name=="too_large")for(int i=0;i<1025;i++)fake_deals.push_back({static_cast<std::uint64_t>(1000+i),5001,5001,(START-100000-i)*1000,0,0});
  if(name=="account_change")fake_change_during_query=true;
 }
}
int main(int argc,char** argv){
 if(argc!=2)return 2;string scenario=argv[1];Fixture(scenario);
 CSyncNoteHistory history;string cursor="",pages="[";int pumps=0,max_queries=0,page_count=0;
 bool more=true;
 while(more){
  if(!history.Begin(START,START+3600,cursor,scenario=="same_second"?100:50))throw std::runtime_error(history.Error());
  while(history.Busy()){
   int before=fake_queries;history.Pump(64);max_queries=std::max(max_queries,fake_queries-before);pumps++;
   // Simulate other EA events changing MT5's globally selected history list.
   if(!fake_deals.empty())HistoryDealSelect(fake_deals.back().ticket);
   if(pumps>20000)throw std::runtime_error("pager did not terminate");
  }
  if(history.Failed()){
   std::cout<<"{\"error\":"<<SNJQuote(history.Error())<<",\"queries\":"<<fake_queries<<",\"max_queries_per_pump\":"<<max_queries<<"}";return 0;
  }
  if(!history.Ready())throw std::runtime_error("pager not ready");
  if(page_count++)pages+=",";
  pages+="{\"deals\":"+history.DealsJson()+",\"through_server\":"+IntegerToString(history.ThroughServer())+",\"has_more\":"+(history.HasMore()?string("true"):string("false"))+",\"cursor\":"+SNJQuote(history.NextCursor())+"}";
  more=history.HasMore();cursor=history.NextCursor();
 }
 std::cout<<"{\"pages\":"<<pages<<"],\"queries\":"<<fake_queries<<",\"max_queries_per_pump\":"<<max_queries<<",\"pumps\":"<<pumps<<"}";
}
