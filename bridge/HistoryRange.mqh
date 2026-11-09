#ifndef TONGPIN_HISTORY_RANGE_MQH
#define TONGPIN_HISTORY_RANGE_MQH

// Call after CopyRates found no rows. A synchronized pair of adjacent bars
// on either side distinguishes an empty interval from an unloaded history edge.
bool SNHistoryRangeEmpty(const string symbol,const ENUM_TIMEFRAMES tf,const long from,const long to)
{
 if(!TerminalInfoInteger(TERMINAL_CONNECTED)||!SeriesInfoInteger(symbol,tf,SERIES_SYNCHRONIZED))return false;
 const int older=iBarShift(symbol,tf,(datetime)to,false);
 if(older<=0)return false;
 datetime bounds[2];
 if(CopyTime(symbol,tf,older-1,2,bounds)!=2)return false;
 return bounds[0]>0&&bounds[0]<from&&bounds[1]>to
  &&TerminalInfoInteger(TERMINAL_CONNECTED)&&SeriesInfoInteger(symbol,tf,SERIES_SYNCHRONIZED);
}

#endif
