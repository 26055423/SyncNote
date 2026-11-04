// Account-bound risk journal and fail-closed single-symbol realized P/L guard.
// Include after SyncNoteLocalSocket.mqh (uses its SHA-256 HashHex helper).
#ifndef SYNCTRADE_RISK
#define SYNCTRADE_RISK
#define SYNCTRADE_RISK_MAX 10000
#define SYNCTRADE_RISK_FILE_MAX 16777216
class CSyncTradeRisk
{
private:
 int m_file,m_size;
 bool m_bad;
 string m_account,m_server,m_key,m_chain;
 string m_ids[SYNCTRADE_RISK_MAX];
 long m_days[SYNCTRADE_RISK_MAX];
 bool m_held[SYNCTRADE_RISK_MAX];
 bool Bound()
 {
  return m_account!="" && m_server!="" && IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))==m_account && AccountInfoString(ACCOUNT_SERVER)==m_server;
 }
 bool Bad(const string reason,string &error){m_bad=true;error=reason;return false;}
 bool Check(string &error)
 {
  if(m_bad || m_file==INVALID_HANDLE){error="RISK_JOURNAL_UNAVAILABLE";return false;}
  if(!Bound()){error="RISK_ACCOUNT_CHANGED";return false;}
  return true;
 }
 bool SafeId(const string id)
 {
  if(StringLen(id)<8 || StringLen(id)>64) return false;
  for(int i=0;i<StringLen(id);i++)
  {
   ushort c=StringGetCharacter(id,i);
   if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-'||c=='_')) return false;
  }
  return true;
 }
 int Find(const string id){for(int i=0;i<m_size;i++)if(m_ids[i]==id)return i;return -1;}
 bool Bounds(ulong &position,ulong &size,string &error)
 {
  ResetLastError();position=FileTell(m_file);
  if(GetLastError()!=0)return Bad("RISK_JOURNAL_TELL_FAILED",error);
  ResetLastError();size=FileSize(m_file);
  if(GetLastError()!=0||position>size)return Bad("RISK_JOURNAL_SIZE_FAILED",error);
  return true;
 }
 bool ReadLine(string &line,string &error)
 {
  line="";ulong position=0,size=0;if(!Bounds(position,size,error))return false;
  while(position<size)
  {
   ResetLastError();int c=FileReadInteger(m_file,CHAR_VALUE);
   if(GetLastError()!=0)return Bad("RISK_JOURNAL_READ_FAILED",error);
   position++;
   if(c==10)return true;
   if(c<0 || c>127 || c==13 || StringLen(line)>=256)return Bad("RISK_JOURNAL_INVALID_ROW",error);
   line+=ShortToString((ushort)c);
  }
  return Bad("RISK_JOURNAL_TRUNCATED_ROW",error);
 }
 bool Append(const string payload,string &error)
 {
  string digest=HashHex(m_chain+"\n"+payload);
  if(StringLen(digest)!=64)return Bad("RISK_JOURNAL_HASH_FAILED",error);
  string row=payload+"\t"+digest+"\n";
  ulong position=0,size=0;if(!Bounds(position,size,error))return false;
  if(size+(ulong)StringLen(row)>SYNCTRADE_RISK_FILE_MAX)return Bad("RISK_JOURNAL_CAPACITY",error);
  ResetLastError();
  if(!FileSeek(m_file,0,SEEK_END))return Bad("RISK_JOURNAL_SEEK_FAILED",error);
  uint wrote=FileWriteString(m_file,row,StringLen(row));FileFlush(m_file);
  if(wrote!=(uint)StringLen(row)||GetLastError()!=0)return Bad("RISK_JOURNAL_WRITE_FAILED",error);
  m_chain=digest;return true;
 }
 bool FeeType(const long type)
 {
  return type==DEAL_TYPE_CHARGE || type==DEAL_TYPE_COMMISSION || type==DEAL_TYPE_COMMISSION_DAILY ||
   type==DEAL_TYPE_COMMISSION_MONTHLY || type==DEAL_TYPE_COMMISSION_AGENT_DAILY || type==DEAL_TYPE_COMMISSION_AGENT_MONTHLY ||
   type==DEAL_TYPE_INTEREST || type==DEAL_TAX;
 }
public:
 CSyncTradeRisk(){m_file=INVALID_HANDLE;m_bad=true;m_size=0;m_account="";m_server="";m_key="";m_chain="";}
 ~CSyncTradeRisk(){Close();}
 void Close()
 {
  if(m_file!=INVALID_HANDLE)FileClose(m_file);
  m_file=INVALID_HANDLE;m_bad=true;m_size=0;m_account="";m_server="";m_key="";m_chain="";
 }
 bool Open(const string account,const string server,string &error)
 {
  Close();error="";m_account=account;m_server=server;
  if(!Bound()){error="RISK_ACCOUNT_UNAVAILABLE";return false;}
  m_key=HashHex(server+"\n"+account);
  if(StringLen(m_key)!=64){error="RISK_ACCOUNT_HASH_FAILED";return false;}
  FolderCreate("TongpinLocal");ResetLastError();
  // No sharing flags: one live writer per account in this terminal's Files scope.
  m_file=FileOpen("TongpinLocal\\quota-"+m_key+".journal",FILE_READ|FILE_WRITE|FILE_BIN|FILE_ANSI,0,CP_UTF8);
  if(m_file==INVALID_HANDLE){error="RISK_JOURNAL_OPEN_FAILED";return false;}
  ulong position=0,size=0;if(!Bounds(position,size,error))return false;
  if(size>SYNCTRADE_RISK_FILE_MAX)return Bad("RISK_JOURNAL_CAPACITY",error);
  m_chain=m_key;
  if(size==0)
  {
   if(!Append("SQR1\t"+m_key,error))return false;
  }
  else
  {
   string header="";
   if(!ReadLine(header,error))return false;
   string expected="SQR1\t"+m_key;
   string digest=HashHex(m_chain+"\n"+expected);
   if(StringLen(digest)!=64||header!=expected+"\t"+digest)return Bad("RISK_JOURNAL_ACCOUNT_OR_HEADER",error);
   m_chain=digest;
   for(;;)
   {
    if(!Bounds(position,size,error))return false;
    if(position==size)break;
    string row="";if(!ReadLine(row,error))return false;
    int a=StringFind(row,"\t"),b=StringFind(row,"\t",a+1),c=StringFind(row,"\t",b+1);
    if(a<1||b<=a+1||c<=b+1||StringFind(row,"\t",c+1)>=0)return Bad("RISK_JOURNAL_INVALID_ROW",error);
    string day_text=StringSubstr(row,0,a),id=StringSubstr(row,a+1,b-a-1),op=StringSubstr(row,b+1,c-b-1);
    long day=StringToInteger(day_text);
    string body=StringSubstr(row,0,c),hash=StringSubstr(row,c+1);
    if(day<1||day>1000000||day_text!=IntegerToString(day)||!SafeId(id)||StringLen(hash)!=64||hash!=HashHex(m_chain+"\n"+body))return Bad("RISK_JOURNAL_CHECKSUM_OR_FIELDS",error);
    int index=Find(id);
    if(op=="R")
    {
     if(index>=0||m_size>=SYNCTRADE_RISK_MAX)return Bad("RISK_JOURNAL_DUPLICATE_RESERVATION",error);
     index=m_size++;m_ids[index]=id;m_days[index]=day;m_held[index]=true;
    }
    else if(op=="L")
    {
     if(index<0||m_days[index]!=day||!m_held[index])return Bad("RISK_JOURNAL_INVALID_RELEASE",error);
     m_held[index]=false;
    }
    else return Bad("RISK_JOURNAL_INVALID_OPERATION",error);
    m_chain=hash;
   }
  }
  m_bad=false;return true;
 }
 bool Healthy(){return !m_bad&&m_file!=INVALID_HANDLE&&Bound();}
 int Reserved(const long broker_day)
 {
  if(!Healthy())return -1;
  int count=0;for(int i=0;i<m_size;i++)if(m_days[i]==broker_day&&m_held[i])count++;
  return count;
 }
 bool Reserve(const string command_id,const long broker_day,const int cap,string &error)
 {
  error="";if(!Check(error))return false;
  long now=(long)TimeTradeServer();
  // cap=0 keeps durable command reservations without a daily count limit.
  if(!SafeId(command_id)||cap<0||broker_day<1||broker_day>1000000||now<=0||broker_day!=now/86400){error="RISK_QUOTA_ARGUMENTS_OR_DAY";return false;}
  // A crash may leave a durable reservation without an execution-intent row.
  // Never return idempotent success: the caller must investigate, not resubmit.
  if(Find(command_id)>=0){error="RISK_COMMAND_ALREADY_RESERVED_OR_USED";return false;}
  if(cap>0 && Reserved(broker_day)>=cap){error="RISK_DAILY_ORDER_LIMIT";return false;}
  if(m_size>=SYNCTRADE_RISK_MAX)return Bad("RISK_JOURNAL_CAPACITY",error);
  if(!Append(IntegerToString(broker_day)+"\t"+command_id+"\tR",error))return false;
  int index=m_size++;m_ids[index]=command_id;m_days[index]=broker_day;m_held[index]=true;return true;
 }
 bool Release(const string command_id,string &error)
 {
  error="";
  // Cleanup is confined to the already-open, exclusively locked account ledger.
  // An account switch can prove a request was not sent: allow that old slot to
  // be released without authorizing any new activity on either account.
  if(m_bad||m_file==INVALID_HANDLE){error="RISK_JOURNAL_UNAVAILABLE";return false;}
  int index=Find(command_id);
  if(index<0){error="RISK_NO_RESERVATION";return false;}
  if(!m_held[index])return true;
  if(!Append(IntegerToString(m_days[index])+"\t"+command_id+"\tL",error))return false;
  m_held[index]=false;return true;
 }
 bool LossAllowed(const string symbol,const double cap,string &error)
 {
  error="";if(!Check(error))return false;
  if(symbol==""||!MathIsValidNumber(cap)||cap<0){error="RISK_LOSS_ARGUMENTS";return false;}
  if(cap==0)return true;
  long now=(long)TimeTradeServer();
  if(now<=0){error="RISK_BROKER_CLOCK_UNAVAILABLE";return false;}
  datetime start=(datetime)(now/86400*86400);
  if(!HistorySelect(start,(datetime)now)){error="RISK_HISTORY_SELECT_FAILED";return false;}
  ResetLastError();int total=HistoryDealsTotal();if(total<0||GetLastError()!=0){error="RISK_HISTORY_COUNT_FAILED";return false;}
  double realized=0;
  for(int i=0;i<total;i++)
  {
   ulong ticket=HistoryDealGetTicket(i);long type=0,entry=0,stamp=0;string deal_symbol="";
   if(ticket==0||!HistoryDealGetInteger(ticket,DEAL_TYPE,type)||!HistoryDealGetString(ticket,DEAL_SYMBOL,deal_symbol)||!HistoryDealGetInteger(ticket,DEAL_TIME,stamp))
   {error="RISK_HISTORY_DEAL_READ_FAILED";return false;}
   if(stamp<(long)start||stamp>now){error="RISK_HISTORY_TIME_MISMATCH";return false;}
   if(deal_symbol!=symbol)continue;
   bool trade=type==DEAL_TYPE_BUY||type==DEAL_TYPE_SELL;
   if(!trade&&!FeeType(type))continue; // Balance/deposit/credit do not erase a trading loss.
   if(trade&&(!HistoryDealGetInteger(ticket,DEAL_ENTRY,entry)||
      (entry!=DEAL_ENTRY_IN&&entry!=DEAL_ENTRY_OUT&&entry!=DEAL_ENTRY_INOUT&&entry!=DEAL_ENTRY_OUT_BY)))
   {error="RISK_HISTORY_ENTRY_READ_FAILED";return false;}
   double profit=0,swap=0,commission=0,fee=0;
   if(!HistoryDealGetDouble(ticket,DEAL_PROFIT,profit)||!HistoryDealGetDouble(ticket,DEAL_SWAP,swap)||
      !HistoryDealGetDouble(ticket,DEAL_COMMISSION,commission)||!HistoryDealGetDouble(ticket,DEAL_FEE,fee)||
      !MathIsValidNumber(profit)||!MathIsValidNumber(swap)||!MathIsValidNumber(commission)||!MathIsValidNumber(fee))
   {error="RISK_HISTORY_AMOUNT_READ_FAILED";return false;}
   realized+=profit+swap+commission+fee;
   if(!MathIsValidNumber(realized)){error="RISK_HISTORY_NON_FINITE_TOTAL";return false;}
  }
  if(!Bound()){error="RISK_ACCOUNT_CHANGED";return false;}
  if(realized<=-cap){error="RISK_DAILY_REALIZED_LOSS_LIMIT";return false;}
  return true;
 }
};
#endif
