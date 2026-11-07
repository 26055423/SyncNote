// Read-only broker symbol directory. Metadata only: no quote subscriptions or trading.
#ifndef SYNCNOTE_SYMBOLS_V1
#define SYNCNOTE_SYMBOLS_V1
#define SNS_PAGE 100
#define SNS_MAX 20000
string g_sns_names[];
string g_sns_id="",g_sns_pending="";
int g_sns_total=0,g_sns_scan=0,g_sns_offset=0,g_sns_count=0,g_sns_failures=0;
ulong g_sns_next=0,g_sns_serial=0;
bool g_sns_active=false;
void SNSymbolsInit()
{
 ArrayResize(g_sns_names,0);g_sns_id="";g_sns_pending="";
 g_sns_total=0;g_sns_scan=0;g_sns_offset=0;g_sns_count=0;g_sns_failures=0;g_sns_next=0;g_sns_active=false;
}
void SNSymbolsRetry(const ulong now)
{
 g_sns_failures=MathMin(g_sns_failures+1,7);
 g_sns_next=now+(ulong)MathMin(300,3*(1<<g_sns_failures))*1000;
}
bool SNSymbolsAck(const string reply)
{
 string raw,id,key;long offset,next,total;
 if(!SNJTop(reply,"ok",raw)||raw!="true"||!SNJTopString(reply,"catalog_id",id)||id!=g_sns_id||
  !SNJTopString(reply,"account_key",key)||key!=g_sn_key||
  !SNJTop(reply,"offset",raw)||!SNJSignedPositive(raw,offset)||offset!=g_sns_offset||
  !SNJTop(reply,"next_offset",raw)||!SNJSignedPositive(raw,next)||next!=g_sns_offset+g_sns_count||
  !SNJTop(reply,"total",raw)||!SNJSignedPositive(raw,total)||total!=g_sns_total||
  !SNJTop(reply,"complete",raw)||raw!=(next==total?"true":"false"))return false;
 return true;
}
bool SNSymbolsPump()
{
 ulong now=GetTickCount64();
 if(g_sn_token==""||g_sn_ack_batches<1||!SNStillBound()||now<g_sns_next)return false;
 if(!g_sns_active)
 {
  int total=SymbolsTotal(false);
  if(total<1||total>SNS_MAX){g_sns_next=now+60000;return false;}
  g_sns_id=SNJHash("syncnote-symbols.v1\n"+g_sn_key+"\n"+g_sn_sync_scope+"\n"+IntegerToString((long)TimeLocal())+"\n"+IntegerToString((long)now)+"\n"+IntegerToString((long)++g_sns_serial));
  if(g_sns_id==""){SNSymbolsRetry(now);return false;}
  g_sns_total=total;g_sns_scan=0;g_sns_offset=0;g_sns_count=0;g_sns_pending="";
  ArrayResize(g_sns_names,total);g_sns_active=true;
 }
 // Capture names first, in bounded work slices; do not subscribe the whole Market Watch.
 if(g_sns_scan<g_sns_total)
 {
  if(SymbolsTotal(false)!=g_sns_total){SNSymbolsInit();g_sns_next=now+30000;return true;}
  int end=MathMin(g_sns_total,g_sns_scan+SNS_PAGE);
  for(int i=g_sns_scan;i<end;i++)
  {
   string name=SymbolName(i,false);
   if(name==""||StringLen(name)>128){SNSymbolsInit();g_sns_next=now+30000;return true;}
   g_sns_names[i]=name;
  }
  g_sns_scan=end;g_sns_next=now+400;return true;
 }
 if(g_sns_pending=="")
 {
  string rows="";int end=MathMin(g_sns_total,g_sns_offset+SNS_PAGE);
  for(int i=g_sns_offset;i<end;i++)
  {
   string name=g_sns_names[i],description="",path="";long mode=0,digits=0;
   // Optional metadata may return 4302 for unselected broker symbols. Never
   // subscribe every symbol or drop its exact code merely to fill display fields.
   SymbolInfoString(name,SYMBOL_DESCRIPTION,description);SymbolInfoString(name,SYMBOL_PATH,path);
   bool has_mode=SymbolInfoInteger(name,SYMBOL_TRADE_MODE,mode),has_digits=SymbolInfoInteger(name,SYMBOL_DIGITS,digits);
   if(rows!="")rows+=",";
   rows+="{\"symbol\":"+SNJQuote(name)+",\"description\":"+SNJQuote(StringSubstr(description,0,256))+
    ",\"path\":"+SNJQuote(StringSubstr(path,0,256));
   if(has_mode)rows+=",\"trade_mode\":"+IntegerToString(mode);
   if(has_digits)rows+=",\"digits\":"+IntegerToString(digits);
   rows+="}";
  }
  g_sns_count=end-g_sns_offset;
  g_sns_pending="{\"account\":"+SNJQuote(g_sn_account)+",\"account_key\":"+SNJQuote(g_sn_key)+",\"server\":"+SNJQuote(g_sn_server)+
   ",\"catalog_id\":"+SNJQuote(g_sns_id)+",\"offset\":"+IntegerToString(g_sns_offset)+",\"total\":"+IntegerToString(g_sns_total)+",\"symbols\":["+rows+"]}";
 }
 string reply;int code=SNPost("/api/mt5/symbols-sync",g_sns_pending,reply);
 if(!SNStillBound()){SNPause("Account changed during symbol directory upload");return true;}
 if(code==401||code==403){SNPause("Symbol directory authorization rejected; inspect website connection settings");return true;}
 if(code==409){SNSymbolsInit();g_sns_next=GetTickCount64()+30000;return true;}
 if(code!=200||!SNSymbolsAck(reply)){SNSymbolsRetry(GetTickCount64());return true;}
 g_sns_offset+=g_sns_count;g_sns_pending="";g_sns_failures=0;
 if(g_sns_offset==g_sns_total)
 {ArrayResize(g_sns_names,0);g_sns_active=false;g_sns_next=GetTickCount64()+3600000;}
 else g_sns_next=GetTickCount64()+3000;
 return true;
}
#endif
