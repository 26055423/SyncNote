#ifndef TONGPIN_QUOTE_SESSIONS_MQH
#define TONGPIN_QUOTE_SESSIONS_MQH

// Broker wall clock. Preserve the extra day in the MT5 end value for overnight sessions.
string SNQuoteSessionsJson(const string symbol)
{
 if(!TerminalInfoInteger(TERMINAL_CONNECTED)||!SymbolIsSynchronized(symbol))return "null";
 string rows="";
 for(int day=0;day<7;day++)
 {
  for(uint index=0;index<=16;index++)
  {
   datetime from=0,to=0;
   if(!SymbolInfoSessionQuote(symbol,(ENUM_DAY_OF_WEEK)day,index,from,to))break;
   if(index==16||from<0||from>=86400||to<=from||to>172800)return "null";
   if(rows!="")rows+=",";
   rows+="["+IntegerToString(day)+","+IntegerToString(from)+","+IntegerToString(to)+"]";
  }
 }
 return rows=="" ? "null" : "["+rows+"]";
}

#endif
