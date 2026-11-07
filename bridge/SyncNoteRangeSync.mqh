// Requested read-only K-line ranges. The website owns the durable job/cursor.
#ifndef SYNCNOTE_RANGE_SYNC_V1
#define SYNCNOTE_RANGE_SYNC_V1
string g_snr_job="",g_snr_segment="",g_snr_symbol="",g_snr_tf="",g_snr_pending="";
long g_snr_from=0,g_snr_to=0;
int g_snr_attempts=0,g_snr_sent=0,g_snr_failures=0;
ulong g_snr_next=0;
void SNRangeInit()
{
 g_snr_job="";g_snr_segment="";g_snr_symbol="";g_snr_tf="";g_snr_pending="";
 g_snr_from=0;g_snr_to=0;g_snr_attempts=0;g_snr_sent=0;g_snr_failures=0;g_snr_next=0;
}
ENUM_TIMEFRAMES SNRangePeriod(const string tf)
{
 if(tf=="M1")return PERIOD_M1;if(tf=="M5")return PERIOD_M5;
 if(tf=="M15")return PERIOD_M15;if(tf=="H1")return PERIOD_H1;
 return PERIOD_CURRENT;
}
string SNRangeIdentity()
{
 return "\"account\":"+SNJQuote(g_sn_account)+",\"account_key\":"+SNJQuote(g_sn_key)+",\"server\":"+SNJQuote(g_sn_server);
}
void SNRangeRetry()
{
 g_snr_failures=MathMin(g_snr_failures+1,7);
 g_snr_next=GetTickCount64()+(ulong)MathMin(300,3*(1<<g_snr_failures))*1000;
}
bool SNRangeAccept(const string reply)
{
 string job,raw,id,segment,symbol,tf,key,account,server;long from,to;
 if(!SNJTop(reply,"ok",raw)||raw!="true"||!SNJTop(reply,"job",job))return false;
 if(job=="null"){g_snr_next=GetTickCount64()+5000;return true;}
 if(!SNJTopString(job,"job_id",id)||id==""||StringLen(id)>128||
  !SNJTopString(job,"segment_id",segment)||segment==""||StringLen(segment)>128||
  !SNJTopString(job,"symbol",symbol)||symbol==""||StringLen(symbol)>128||
  !SNJTopString(job,"tf",tf)||SNRangePeriod(tf)==PERIOD_CURRENT||
  !SNJTopString(job,"account_key",key)||key!=g_sn_key||
  !SNJTopString(job,"account",account)||account!=g_sn_account||
  !SNJTopString(job,"server",server)||server!=g_sn_server||
  !SNJTop(job,"from_server",raw)||!SNJSignedPositive(raw,from)||from<1||
  !SNJTop(job,"to_server",raw)||!SNJSignedPositive(raw,to)||to<from)return false;
 int seconds=PeriodSeconds(SNRangePeriod(tf));long now=(long)TimeTradeServer();
 if(from%seconds!=0||to%seconds!=0||(to-from)/seconds+1>2000||to+seconds>now)return false;
 g_snr_job=id;g_snr_segment=segment;g_snr_symbol=symbol;g_snr_tf=tf;
 g_snr_from=from;g_snr_to=to;g_snr_attempts=0;g_snr_pending="";g_snr_failures=0;
 g_snr_next=GetTickCount64()+400;return true;
}
bool SNRangeAcknowledged(const string reply)
{
 string raw,value;long number;
 if(!SNJTop(reply,"ok",raw)||raw!="true")return false;
 if(!SNJTopString(reply,"job_id",value)||value!=g_snr_job||!SNJTopString(reply,"segment_id",value)||value!=g_snr_segment||
  !SNJTopString(reply,"account_key",value)||value!=g_sn_key||!SNJTopString(reply,"symbol",value)||value!=g_snr_symbol||
  !SNJTopString(reply,"tf",value)||value!=g_snr_tf)return false;
 if(!SNJTopString(reply,"status",value)||(value!="running"&&value!="completed"&&value!="partial"))return false;
 if(!SNJTop(reply,"from_server",raw)||!SNJSignedPositive(raw,number)||number!=g_snr_from||
  !SNJTop(reply,"to_server",raw)||!SNJSignedPositive(raw,number)||number!=g_snr_to||
  !SNJTop(reply,"accepted",raw)||!SNJSignedPositive(raw,number)||number!=g_snr_sent)return false;
 return true;
}
bool SNRangeBuild()
{
 g_snr_attempts++;
 MqlRates rates[];ArraySetAsSeries(rates,false);
 ENUM_TIMEFRAMES period=SNRangePeriod(g_snr_tf);int seconds=PeriodSeconds(period);
 long now=(long)TimeTradeServer(),last=0;int expected=(int)((g_snr_to-g_snr_from)/seconds+1);
 bool selected=SymbolSelect(g_snr_symbol,true);
 int count=selected?CopyRates(g_snr_symbol,period,(datetime)g_snr_from,(datetime)g_snr_to,rates):-1;
 if(!SNStillBound()){SNPause("Account changed during requested K-line read");return false;}
 if(count<0||count>2000||count>ArraySize(rates))count=-1;
 string rows="";g_snr_sent=0;
 for(int i=0;i<count;i++)
 {
  long t=(long)rates[i].time;
  if(t<g_snr_from||t>g_snr_to||t%seconds!=0||t+seconds>now||t<=last||
   !MathIsValidNumber(rates[i].open)||!MathIsValidNumber(rates[i].high)||!MathIsValidNumber(rates[i].low)||!MathIsValidNumber(rates[i].close)||
   rates[i].open<=0||rates[i].low<=0||rates[i].close<=0||rates[i].high<MathMax(rates[i].open,rates[i].close)||rates[i].low>MathMin(rates[i].open,rates[i].close)||rates[i].high<rates[i].low||rates[i].tick_volume<0)continue;
  if(g_snr_sent>0)rows+=",";
  rows+="["+IntegerToString(t)+","+SNJNumber(rates[i].open)+","+SNJNumber(rates[i].high)+","+SNJNumber(rates[i].low)+","+SNJNumber(rates[i].close)+","+IntegerToString((long)rates[i].tick_volume)+"]";
  last=t;g_snr_sent++;
 }
 // A first CopyRates call can start MT5 asynchronous history download.
 // Give unavailable series a bounded minute without advancing the server segment.
 if(count<0&&g_snr_attempts<12){g_snr_next=GetTickCount64()+5000;return false;}
 if(count>=0&&g_snr_sent<expected&&g_snr_attempts<3){g_snr_next=GetTickCount64()+2000;return false;}
 string error=count<0?"history_unavailable":g_snr_sent==0?"empty_window":g_snr_sent<expected?"partial_window":"";
 g_snr_pending="{"+SNRangeIdentity()+",\"job_id\":"+SNJQuote(g_snr_job)+",\"segment_id\":"+SNJQuote(g_snr_segment)+
  ",\"symbol\":"+SNJQuote(g_snr_symbol)+",\"tf\":"+SNJQuote(g_snr_tf)+",\"from_server\":"+IntegerToString(g_snr_from)+
  ",\"to_server\":"+IntegerToString(g_snr_to)+",\"error\":"+SNJQuote(error)+",\"bars\":["+rows+"]}";
 return true;
}
bool SNRangePump()
{
 if(g_sn_token==""||g_sn_ack_batches<1||!SNStillBound()||GetTickCount64()<g_snr_next)return false;
 if(g_snr_job=="")
 {
  string reply;int code=SNPost("/api/mt5/bar-sync/poll","{"+SNRangeIdentity()+"}",reply);
  if(!SNStillBound()){SNPause("Account changed during requested K-line polling");return true;}
  if(code==401||code==403){SNPause("Requested K-line authorization rejected");return true;}
  if(code!=200||!SNRangeAccept(reply)){SNRangeRetry();return true;}
  return true;
 }
 if(g_snr_pending=="")
 {
  if(!SNRangeBuild())return true;
  g_snr_next=GetTickCount64()+400;return true;
 }
 string reply;int code=SNPost("/api/mt5/bar-sync/result",g_snr_pending,reply);
 if(!SNStillBound()){SNPause("Account changed during requested K-line upload");return true;}
 if(code==401||code==403){SNPause("Requested K-line authorization rejected");return true;}
 if(code==409){SNRangeInit();g_snr_next=GetTickCount64()+5000;return true;}
 if(code!=200||!SNRangeAcknowledged(reply)){SNRangeRetry();return true;}
 SNRangeInit();g_snr_next=GetTickCount64()+1000;return true;
}
#endif
