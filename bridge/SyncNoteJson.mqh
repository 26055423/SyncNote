// Pure MQL5 JSON/identity helpers shared by SyncNote and SyncTrade. No DLLs.
#ifndef SYNCNOTE_JSON_COMMON
#define SYNCNOTE_JSON_COMMON
string SNJChar(const ushort code)
{
 string value=" ";StringSetCharacter(value,0,code);return value;
}
string SNJQuote(const string value)
{
 string out="\"";
 for(int i=0;i<StringLen(value);i++)
 {
  ushort c=StringGetCharacter(value,i);
  if(c=='"')out+="\\\"";
  else if(c=='\\')out+="\\\\";
  else if(c=='\r')out+="\\r";
  else if(c=='\n')out+="\\n";
  else if(c=='\t')out+="\\t";
  else if(c<32)out+=StringFormat("\\u%04X",(uint)c);
  else out+=SNJChar(c);
 }
 return out+"\"";
}
string SNJNumber(const double value)
{
 return MathIsValidNumber(value)?DoubleToString(value,-16):"null";
}
string SNJUlong(const ulong value){return StringFormat("%I64u",value);}
string SNJHash(const string value)
{
 uchar bytes[],key[],hash[];int n=StringToCharArray(value,bytes,0,-1,CP_UTF8)-1;
 ArrayResize(bytes,n);ArrayResize(key,0);
 if(CryptEncode(CRYPT_HASH_SHA256,bytes,key,hash)!=32)return "";
 string out="",digits="0123456789abcdef";
 for(int i=0;i<32;i++)out+=StringSubstr(digits,hash[i]>>4,1)+StringSubstr(digits,hash[i]&15,1);
 return out;
}
string SNJAccountKey(const string server,const string account){return SNJHash(server+"\n"+account);}
bool SNJUnsigned(const string value,ulong &out)
{
 out=0;if(StringLen(value)<1||StringLen(value)>20)return false;
 if(StringLen(value)>1&&StringGetCharacter(value,0)=='0')return false;
 for(int i=0;i<StringLen(value);i++)
 {
  ushort c=StringGetCharacter(value,i);if(c<'0'||c>'9')return false;
  ulong digit=(ulong)(c-'0');
  if(out>((ulong)-1-digit)/10)return false;
  out=out*10+digit;
 }
 return true;
}
bool SNJSignedPositive(const string value,long &out)
{
 ulong number=0;if(!SNJUnsigned(value,number)||number>9223372036854775807)return false;
 out=(long)number;return true;
}
void SNJSpace(const string text,int &p)
{
 while(p<StringLen(text))
 {
  ushort c=StringGetCharacter(text,p);if(c!=32&&c!=9&&c!=10&&c!=13)break;p++;
 }
}
int SNJHex(const ushort c)
{
 if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;if(c>='A'&&c<='F')return c-'A'+10;return -1;
}
bool SNJReadString(const string text,int &p,string &value)
{
 value="";int n=StringLen(text);if(p>=n||StringGetCharacter(text,p++)!='"')return false;
 while(p<n)
 {
  ushort c=StringGetCharacter(text,p++);if(c=='"')return true;if(c<32)return false;
  if(c!='\\'){value+=SNJChar(c);continue;}
  if(p>=n)return false;c=StringGetCharacter(text,p++);
  if(c=='"'||c=='\\'||c=='/')value+=SNJChar(c);
  else if(c=='b')value+=SNJChar(8);
  else if(c=='f')value+=SNJChar(12);
  else if(c=='n')value+="\n";
  else if(c=='r')value+="\r";
  else if(c=='t')value+="\t";
  else if(c=='u')
  {
   int code=0;
   for(int i=0;i<4;i++){if(p>=n)return false;int d=SNJHex(StringGetCharacter(text,p++));if(d<0)return false;code=code*16+d;}
   value+=SNJChar((ushort)code);
  }
  else return false;
 }
 return false;
}
bool SNJNumberToken(const string t)
{
 int p=0,n=StringLen(t);if(n==0)return false;if(StringGetCharacter(t,p)=='-')p++;if(p>=n)return false;
 ushort c=StringGetCharacter(t,p++);
 if(c=='0'){if(p<n&&StringGetCharacter(t,p)>='0'&&StringGetCharacter(t,p)<='9')return false;}
 else{if(c<'1'||c>'9')return false;while(p<n&&StringGetCharacter(t,p)>='0'&&StringGetCharacter(t,p)<='9')p++;}
 if(p<n&&StringGetCharacter(t,p)=='.'){p++;int start=p;while(p<n&&StringGetCharacter(t,p)>='0'&&StringGetCharacter(t,p)<='9')p++;if(start==p)return false;}
 if(p<n&&(StringGetCharacter(t,p)=='e'||StringGetCharacter(t,p)=='E')){p++;if(p<n&&(StringGetCharacter(t,p)=='+'||StringGetCharacter(t,p)=='-'))p++;int start=p;while(p<n&&StringGetCharacter(t,p)>='0'&&StringGetCharacter(t,p)<='9')p++;if(start==p)return false;}
 return p==n;
}
bool SNJSkipValue(const string text,int &p,const int depth=0)
{
 if(depth>12)return false;SNJSpace(text,p);int n=StringLen(text);if(p>=n)return false;
 ushort c=StringGetCharacter(text,p);
 if(c=='"'){string ignored;return SNJReadString(text,p,ignored);}
 if(c=='{'||c=='[')
 {
  bool object=c=='{';ushort close=object?'}':']';p++;SNJSpace(text,p);
  if(p<n&&StringGetCharacter(text,p)==close){p++;return true;}
  while(p<n)
  {
   if(object){string key;if(!SNJReadString(text,p,key))return false;SNJSpace(text,p);if(p>=n||StringGetCharacter(text,p++)!=':')return false;}
   if(!SNJSkipValue(text,p,depth+1))return false;SNJSpace(text,p);if(p>=n)return false;
   c=StringGetCharacter(text,p++);if(c==close)return true;if(c!=',')return false;SNJSpace(text,p);
  }
  return false;
 }
 int begin=p;
 while(p<n){c=StringGetCharacter(text,p);if(c==','||c=='}'||c==']'||c==32||c==9||c==10||c==13)break;p++;}
 string t=StringSubstr(text,begin,p-begin);
 return t=="true"||t=="false"||t=="null"||SNJNumberToken(t);
}
// Return one top-level primitive as its raw JSON text; reject duplicates/malformed body.
bool SNJTop(const string text,const string wanted,string &raw)
{
 raw="";int p=0,n=StringLen(text);SNJSpace(text,p);if(p>=n||StringGetCharacter(text,p++)!='{')return false;
 string seen[];SNJSpace(text,p);
 if(p<n&&StringGetCharacter(text,p)=='}')return false;
 while(p<n)
 {
  string key;if(!SNJReadString(text,p,key))return false;
  for(int i=0;i<ArraySize(seen);i++)if(seen[i]==key)return false;
  int k=ArraySize(seen);if(k>=128||StringLen(key)>128)return false;ArrayResize(seen,k+1);seen[k]=key;
  SNJSpace(text,p);if(p>=n||StringGetCharacter(text,p++)!=':')return false;
  SNJSpace(text,p);int begin=p;if(!SNJSkipValue(text,p))return false;
  if(key==wanted)raw=StringSubstr(text,begin,p-begin);
  SNJSpace(text,p);if(p>=n)return false;ushort end=StringGetCharacter(text,p++);
  if(end=='}'){SNJSpace(text,p);return p==n&&raw!="";}
  if(end!=',')return false;SNJSpace(text,p);
 }
 return false;
}
bool SNJTopString(const string text,const string key,string &out)
{
 string raw;if(!SNJTop(text,key,raw))return false;int p=0;
 return SNJReadString(raw,p,out)&&p==StringLen(raw);
}
bool SNJAcknowledged(const string reply,const string account_key,const string batch_id)
{
 string raw,account,batch;
 return SNJTop(reply,"ok",raw)&&raw=="true"&&SNJTopString(reply,"account_key",account)&&account==account_key&&SNJTopString(reply,"batch_id",batch)&&batch==batch_id;
}
#endif
