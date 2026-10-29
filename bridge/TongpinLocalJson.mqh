// Flat JSON helpers adapted from WebBridge.mq5. Strict validation is below.
#ifndef TONGPIN_LOCAL_JSON
#define TONGPIN_LOCAL_JSON
string JKey(const string key)
{
   return "\"" + key + "\":";
}

string JsonChar(const ushort code)
{
   string s = " ";
   StringSetCharacter(s, 0, code);
   return s;
}

string Hex4(const ushort code)
{
   string digits = "0123456789ABCDEF";
   string out = "";
   out += StringSubstr(digits, (code >> 12) & 15, 1);
   out += StringSubstr(digits, (code >> 8) & 15, 1);
   out += StringSubstr(digits, (code >> 4) & 15, 1);
   out += StringSubstr(digits, code & 15, 1);
   return out;
}

string JsonEscape(const string value)
{
   string out = "";
   int len = StringLen(value);
   for(int i = 0; i < len; i++)
   {
      ushort c = StringGetCharacter(value, i);
      if(c == '"')
         out += "\\\"";
      else if(c == '\\')
         out += "\\\\";
      else if(c == '\n')
         out += "\\n";
      else if(c == '\r')
         out += "\\r";
      else if(c == '\t')
         out += "\\t";
      else if(c == 8)
         out += "\\b";
      else if(c == 12)
         out += "\\f";
      else if(c < 32)
         out += "\\u" + Hex4(c);
      else
         out += JsonChar(c);
   }
   return out;
}

string JStr(const string value)
{
   return "\"" + JsonEscape(value) + "\"";
}

string JNum(const double value, const int digits)
{
   if(!MathIsValidNumber(value))
      return "0";
   return DoubleToString(value, digits);
}

string JLong(const long value)
{
   return IntegerToString(value);
}

string g_json_source="";
string g_json_keys[];
int g_json_values[];
int JsonValuePos(const string js, const string key)
{
   if(js != g_json_source) return -1;
   for(int i=0;i<ArraySize(g_json_keys);i++)
      if(g_json_keys[i]==key) return g_json_values[i];
   return -1;
}

int HexDigit(const ushort c)
{
   if(c >= '0' && c <= '9')
      return (int)(c - '0');
   if(c >= 'a' && c <= 'f')
      return 10 + (int)(c - 'a');
   if(c >= 'A' && c <= 'F')
      return 10 + (int)(c - 'A');
   return -1;
}

bool JsonGetString(const string js, const string key, string &out)
{
   int pos = JsonValuePos(js, key);
   if(pos < 0)
      return false;
   int len = StringLen(js);
   if(pos >= len || StringGetCharacter(js, pos) != '"')
      return false;
   pos++;
   out = "";
   while(pos < len)
   {
      ushort c = StringGetCharacter(js, pos);
      if(c == '"')
         return true;
      if(c != '\\')
      {
         out += JsonChar(c);
         pos++;
         continue;
      }
      pos++;
      if(pos >= len)
         return false;
      ushort esc = StringGetCharacter(js, pos);
      if(esc == '"')
      {
         out += "\"";
         pos++;
      }
      else if(esc == '\\')
      {
         out += "\\";
         pos++;
      }
      else if(esc == '/')
      {
         out += "/";
         pos++;
      }
      else if(esc == 'b')
      {
         out += CharToString(8);
         pos++;
      }
      else if(esc == 'f')
      {
         out += CharToString(12);
         pos++;
      }
      else if(esc == 'n')
      {
         out += "\n";
         pos++;
      }
      else if(esc == 'r')
      {
         out += "\r";
         pos++;
      }
      else if(esc == 't')
      {
         out += "\t";
         pos++;
      }
      else if(esc == 'u')
      {
         ushort code = 0;
         bool ok = true;
         for(int k = 0; k < 4; k++)
         {
            if(pos + 1 + k >= len)
            {
               ok = false;
               break;
            }
            int d = HexDigit(StringGetCharacter(js, pos + 1 + k));
            if(d < 0)
            {
               ok = false;
               break;
            }
            code = (ushort)(code * 16 + d);
         }
         if(!ok)
            return false;
         out += JsonChar(code);
         pos += 5;
      }
      else
      {
         out += JsonChar(esc);
         pos++;
      }
   }
   return false;
}

bool JsonGetDouble(const string js, const string key, double &out)
{
   int pos = JsonValuePos(js, key);
   if(pos < 0)
      return false;
   int len = StringLen(js);
   int end = pos;
   while(end < len)
   {
      ushort c = StringGetCharacter(js, end);
      if(c == ',' || c == '}' || c == ' ' || c == '\t' || c == '\r' || c == '\n')
         break;
      end++;
   }
   if(end <= pos)
      return false;
   string token = StringSubstr(js, pos, end - pos);
   out = StringToDouble(token);
   return true;
}

bool JsonGetLong(const string js, const string key, long &out)
{
   int pos = JsonValuePos(js, key);
   if(pos < 0)
      return false;
   int len = StringLen(js);
   int end = pos;
   while(end < len)
   {
      ushort c = StringGetCharacter(js, end);
      if(c == ',' || c == '}' || c == ' ' || c == '\t' || c == '\r' || c == '\n')
         break;
      end++;
   }
   if(end <= pos)
      return false;
   out = StringToInteger(StringSubstr(js, pos, end - pos));
   return true;
}

bool JsonGetBool(const string js, const string key, bool &out)
{
   int pos = JsonValuePos(js, key);
   if(pos < 0)
      return false;
   string token = StringSubstr(js, pos, 4);
   if(token == "true")
   {
      out = true;
      return true;
   }
   if(StringSubstr(js, pos, 5) == "false")
   {
      out = false;
      return true;
   }
   return false;
}

bool JsonSpace(const ushort c) { return c==32 || c==9 || c==10 || c==13; }
void JsonSkipSpace(const string js,int &p)
{
   while(p<StringLen(js) && JsonSpace(StringGetCharacter(js,p))) p++;
}
// Reject malformed escapes, control characters and unpaired UTF-16 surrogates.
bool JsonSkipString(const string js,int &p)
{
   if(p>=StringLen(js) || StringGetCharacter(js,p)!='"') return false;
   p++;
   while(p<StringLen(js))
   {
      ushort c=StringGetCharacter(js,p++);
      if(c=='"') return true;
      if(c<32) return false;
      if(c=='\\')
      {
         if(p>=StringLen(js)) return false;
         ushort e=StringGetCharacter(js,p++);
         if(e=='u')
         {
            int code=0;
            for(int j=0;j<4;j++)
            {
               if(p>=StringLen(js)) return false;
               int d=HexDigit(StringGetCharacter(js,p++));
               if(d<0) return false;
               code=code*16+d;
            }
            if(code>=0xD800 && code<=0xDBFF)
            {
               if(StringSubstr(js,p,2)!="\\u") return false;
               p+=2; int low=0;
               for(int j=0;j<4;j++)
               {
                  if(p>=StringLen(js)) return false;
                  int d=HexDigit(StringGetCharacter(js,p++));
                  if(d<0) return false;
                  low=low*16+d;
               }
               if(low<0xDC00 || low>0xDFFF) return false;
            }
            else if(code>=0xDC00 && code<=0xDFFF) return false;
         }
         else if(e!='"' && e!='\\' && e!='/' && e!='b' && e!='f' && e!='n' && e!='r' && e!='t') return false;
      }
      else if(c>=0xD800 && c<=0xDBFF)
      {
         if(p>=StringLen(js)) return false;
         ushort low=StringGetCharacter(js,p++);
         if(low<0xDC00 || low>0xDFFF) return false;
      }
      else if(c>=0xDC00 && c<=0xDFFF) return false;
   }
   return false;
}
bool JsonNumberToken(const string t)
{
   int p=0,n=StringLen(t);
   if(n==0) return false;
   if(StringGetCharacter(t,p)=='-') p++;
   if(p>=n) return false;
   ushort c=StringGetCharacter(t,p++);
   if(c=='0') { if(p<n && StringGetCharacter(t,p)>='0' && StringGetCharacter(t,p)<='9') return false; }
   else
   {
      if(c<'1'||c>'9') return false;
      while(p<n && StringGetCharacter(t,p)>='0' && StringGetCharacter(t,p)<='9') p++;
   }
   if(p<n && StringGetCharacter(t,p)=='.')
   {
      p++; int begin=p;
      while(p<n && StringGetCharacter(t,p)>='0' && StringGetCharacter(t,p)<='9') p++;
      if(p==begin) return false;
   }
   if(p<n && (StringGetCharacter(t,p)=='e'||StringGetCharacter(t,p)=='E'))
   {
      p++;
      if(p<n && (StringGetCharacter(t,p)=='+'||StringGetCharacter(t,p)=='-')) p++;
      int begin=p;
      while(p<n && StringGetCharacter(t,p)>='0' && StringGetCharacter(t,p)<='9') p++;
      if(p==begin) return false;
   }
   return p==n && MathIsValidNumber(StringToDouble(t));
}
// Local requests deliberately allow flat primitive fields only. No substring key lookup.
bool JsonValidateFlat(const string js)
{
   g_json_source=""; ArrayResize(g_json_keys,0); ArrayResize(g_json_values,0);
   int p=0,n=StringLen(js); JsonSkipSpace(js,p);
   if(p>=n || StringGetCharacter(js,p++)!='{') return false;
   JsonSkipSpace(js,p);
   if(p<n && StringGetCharacter(js,p)=='}') {p++;JsonSkipSpace(js,p);g_json_source=js;return p==n;}
   while(p<n)
   {
      if(StringGetCharacter(js,p++)!='"') return false;
      int begin=p;
      while(p<n && StringGetCharacter(js,p)!='"')
      {
         ushort c=StringGetCharacter(js,p++);
         if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_')) return false;
      }
      if(p>=n || p-begin<1 || p-begin>64) return false;
      string key=StringSubstr(js,begin,p-begin); p++;
      for(int i=0;i<ArraySize(g_json_keys);i++) if(g_json_keys[i]==key) return false;
      JsonSkipSpace(js,p);
      if(p>=n || StringGetCharacter(js,p++)!=':') return false;
      JsonSkipSpace(js,p); int value=p;
      if(p<n && StringGetCharacter(js,p)=='"') {if(!JsonSkipString(js,p)) return false;}
      else
      {
         begin=p;
         while(p<n && StringGetCharacter(js,p)!=',' && StringGetCharacter(js,p)!='}' && !JsonSpace(StringGetCharacter(js,p))) p++;
         string t=StringSubstr(js,begin,p-begin);
         if(t!="true" && t!="false" && t!="null" && !JsonNumberToken(t)) return false;
      }
      int k=ArraySize(g_json_keys);
      if(k>=40) return false;
      ArrayResize(g_json_keys,k+1);ArrayResize(g_json_values,k+1);
      g_json_keys[k]=key;g_json_values[k]=value;
      JsonSkipSpace(js,p);
      if(p>=n) return false;
      ushort end=StringGetCharacter(js,p++);
      if(end=='}') {JsonSkipSpace(js,p);if(p!=n) return false;g_json_source=js;return true;}
      if(end!=',') return false;
      JsonSkipSpace(js,p);
   }
   return false;
}
bool JsonKeysAllowed(const string allowed)
{
   for(int i=0;i<ArraySize(g_json_keys);i++)
      if(StringFind(","+allowed+",",","+g_json_keys[i]+",")<0) return false;
   return true;
}
bool JsonNumber(const string js,const string key,double &out,const double fallback=0)
{
   out=fallback;
   int p=JsonValuePos(js,key);
   if(p<0) return true;
   ushort c=StringGetCharacter(js,p);
   if(c=='"'||c=='t'||c=='f'||c=='n') return false;
   return JsonGetDouble(js,key,out) && MathIsValidNumber(out);
}
bool JsonId(const string js,const string key,string &out)
{
   if(!JsonGetString(js,key,out) || StringLen(out)<1 || StringLen(out)>20) return false;
   for(int i=0;i<StringLen(out);i++) if(StringGetCharacter(out,i)<'0'||StringGetCharacter(out,i)>'9') return false;
   // MT5 IDs fit signed 64-bit in this bridge; prohibit overflow and ambiguous leading zeros.
   if(StringLen(out)>1 && StringSubstr(out,0,1)=="0") return false;
   if(StringLen(out)>19 || (StringLen(out)==19 && StringCompare(out,"9223372036854775807")>0)) return false;
   return StringToInteger(out)>0;
}
bool SafeCommandId(const string id)
{
   if(StringLen(id)<8 || StringLen(id)>64) return false;
   for(int i=0;i<StringLen(id);i++)
   {
      ushort c=StringGetCharacter(id,i);
      if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-'||c=='_')) return false;
   }
   return true;
}
#endif
