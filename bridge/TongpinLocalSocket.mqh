// Windows-only loopback RFC 6455 transport. No custom DLLs or helper process.
#ifndef TONGPIN_LOCAL_SOCKET
#define TONGPIN_LOCAL_SOCKET
#import "Ws2_32.dll"
int WSAStartup(ushort version,uchar &data[]);
int WSACleanup();
ulong socket(int af,int type,int protocol);
int bind(ulong s,uchar &name[],int len);
int listen(ulong s,int backlog);
ulong accept(ulong s,uchar &address[],int &length);
int ioctlsocket(ulong s,int command,uint &value);
int setsockopt(ulong s,int level,int option,uchar &value[],int length);
int recv(ulong s,uchar &buffer[],int length,int flags);
int send(ulong s,uchar &buffer[],int length,int flags);
int closesocket(ulong s);
int WSAGetLastError();
#import
#import "bcrypt.dll"
int BCryptGenRandom(ulong algorithm,uchar &buffer[],uint length,uint flags);
#import

#define LOCAL_PEERS 4
#define WS_MESSAGE_MAX 32768
#define WS_OUTPUT_MAX 524288
#define WIN_INVALID_SOCKET ((ulong)-1)

void LocalMessage(const int index,const string message);
void LocalOpened(const int index);
void LocalClosed(const int index);

class CLocalPeer
{
public:
   ulong handle;
   bool upgraded;
   bool authenticated;
   bool closing;
   ulong opened_ms;
   ulong seen_ms;
   uchar rx[];
   uchar tx[];
   int tx_offset;
   uchar fragment[];
   bool fragment_open;
   string origin;
   void Reset()
   {
      handle=WIN_INVALID_SOCKET;upgraded=false;authenticated=false;closing=false;
      opened_ms=0;seen_ms=0;tx_offset=0;fragment_open=false;origin="";
      ArrayResize(rx,0);ArrayResize(tx,0);ArrayResize(fragment,0);
   }
};
CLocalPeer g_local_peers[LOCAL_PEERS];
ulong g_listener=WIN_INVALID_SOCKET;
bool g_winsock_started=false;

long LocalUtcMs() { return (long)TimeGMT()*1000; }
bool RandomBytes(uchar &bytes[],const int count)
{
   ArrayResize(bytes,count);
   return BCryptGenRandom(0,bytes,(uint)count,2)>=0;
}
string RandomHex(const int count)
{
   uchar bytes[];
   if(!RandomBytes(bytes,count)) return "";
   string digits="0123456789abcdef",out="";
   for(int i=0;i<count;i++) out+=StringSubstr(digits,bytes[i]>>4,1)+StringSubstr(digits,bytes[i]&15,1);
   return out;
}
string HashHex(const string text)
{
   uchar bytes[],key[],hash[];
   int n=StringToCharArray(text,bytes,0,-1,CP_UTF8)-1;
   ArrayResize(bytes,n);ArrayResize(key,0);
   if(CryptEncode(CRYPT_HASH_SHA256,bytes,key,hash)!=32) return "";
   string digits="0123456789abcdef",out="";
   for(int i=0;i<ArraySize(hash);i++) out+=StringSubstr(digits,hash[i]>>4,1)+StringSubstr(digits,hash[i]&15,1);
   return out;
}
void WsDrop(const int index)
{
   if(g_local_peers[index].handle!=WIN_INVALID_SOCKET) closesocket(g_local_peers[index].handle);
   g_local_peers[index].Reset();
   LocalClosed(index);
}
bool WsRaw(const int index,const uchar &data[])
{
   int left=ArraySize(g_local_peers[index].tx)-g_local_peers[index].tx_offset;
   int n=ArraySize(data);
   if(left+n>WS_OUTPUT_MAX) {WsDrop(index);return false;}
   if(g_local_peers[index].tx_offset>0)
   {
      ArrayCopy(g_local_peers[index].tx,g_local_peers[index].tx,0,g_local_peers[index].tx_offset,left);
      ArrayResize(g_local_peers[index].tx,left);g_local_peers[index].tx_offset=0;
   }
   ArrayResize(g_local_peers[index].tx,left+n);
   ArrayCopy(g_local_peers[index].tx,data,left,0,n);
   return true;
}
bool WsFrame(const int index,const uchar opcode,const uchar &payload[])
{
   int n=ArraySize(payload),head=(n<126 ? 2 : n<=65535 ? 4 : 10);
   uchar out[];ArrayResize(out,head+n);ArrayInitialize(out,0);
   out[0]=(uchar)(128|opcode);
   if(head==2) out[1]=(uchar)n;
   else if(head==4) {out[1]=126;out[2]=(uchar)(n>>8);out[3]=(uchar)n;}
   else
   {
      out[1]=127;
      for(int i=0;i<8;i++) out[2+i]=(uchar)(((ulong)n)>>((7-i)*8));
   }
   ArrayCopy(out,payload,head,0,n);
   return WsRaw(index,out);
}
bool WsText(const int index,const string text)
{
   if(index<0 || index>=LOCAL_PEERS || g_local_peers[index].handle==WIN_INVALID_SOCKET || !g_local_peers[index].upgraded || g_local_peers[index].closing) return false;
   uchar bytes[];int n=StringToCharArray(text,bytes,0,-1,CP_UTF8)-1;
   ArrayResize(bytes,n);
   return WsFrame(index,1,bytes);
}
void WsClose(const int index,const int code)
{
   if(g_local_peers[index].handle==WIN_INVALID_SOCKET) return;
   uchar payload[];ArrayResize(payload,2);payload[0]=(uchar)(code>>8);payload[1]=(uchar)code;
   if(g_local_peers[index].upgraded) WsFrame(index,8,payload);
   g_local_peers[index].closing=true;
}
string LowerTrim(string value)
{
   StringTrimLeft(value);StringTrimRight(value);StringToLower(value);return value;
}
// Strict HTTP headers: duplicates are rejected, including Origin and WebSocket keys.
string HttpHeader(const string request,const string wanted,bool &valid)
{
   string lines[];StringSplit(request,10,lines);
   string found="";int matches=0;
   for(int i=1;i<ArraySize(lines);i++)
   {
      string line=lines[i];StringTrimRight(line);
      if(line=="") continue;
      if(StringSubstr(line,0,1)==" " || StringSubstr(line,0,1)=="\t") {valid=false;return "";}
      int colon=StringFind(line,":");
      if(colon<1) {valid=false;return "";}
      if(LowerTrim(StringSubstr(line,0,colon))==wanted)
      {
         found=StringSubstr(line,colon+1);StringTrimLeft(found);StringTrimRight(found);matches++;
      }
   }
   if(matches>1) valid=false;
   return found;
}
void RxConsume(const int index,const int count)
{
   int remain=ArraySize(g_local_peers[index].rx)-count;
   if(remain>0) ArrayCopy(g_local_peers[index].rx,g_local_peers[index].rx,0,count,remain);
   ArrayResize(g_local_peers[index].rx,MathMax(0,remain));
}
bool WsHandshake(const int index,const string allowed_origin,const int port)
{
   int n=ArraySize(g_local_peers[index].rx),end=-1;
   for(int i=3;i<n;i++)
      if(g_local_peers[index].rx[i-3]==13 && g_local_peers[index].rx[i-2]==10 && g_local_peers[index].rx[i-1]==13 && g_local_peers[index].rx[i]==10) {end=i+1;break;}
   if(end<0) {if(n>8192) WsDrop(index);return false;}
   string request=CharArrayToString(g_local_peers[index].rx,0,end,CP_UTF8);
   bool valid=true;
   string origin=HttpHeader(request,"origin",valid);
   string host=HttpHeader(request,"host",valid);
   string key=HttpHeader(request,"sec-websocket-key",valid);
   string upgrade=LowerTrim(HttpHeader(request,"upgrade",valid));
   string connection=LowerTrim(HttpHeader(request,"connection",valid));StringReplace(connection," ","");StringReplace(connection,"\t","");
   string version=HttpHeader(request,"sec-websocket-version",valid);
   string protocols=HttpHeader(request,"sec-websocket-protocol",valid);StringReplace(protocols," ","");StringReplace(protocols,"\t","");
   string ext=HttpHeader(request,"sec-websocket-extensions",valid); // Extensions deliberately not negotiated.
   if(!valid || StringSubstr(request,0,18)!="GET /ws HTTP/1.1\r\n" || origin!=allowed_origin || host!="127.0.0.1:"+IntegerToString(port) || upgrade!="websocket" || StringFind(","+connection+",",",upgrade,")<0 || version!="13" || StringFind(","+protocols+",",",tongpin-local.v1,")<0)
   {WsDrop(index);return false;}
   uchar encoded[],empty[],decoded[];
   int len=StringToCharArray(key,encoded,0,-1,CP_UTF8)-1;ArrayResize(encoded,len);
   if(CryptDecode(CRYPT_BASE64,encoded,empty,decoded)!=16) {WsDrop(index);return false;}
   string handshake_source=key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
   uchar bytes[],hash[],b64[];
   len=StringToCharArray(handshake_source,bytes,0,-1,CP_UTF8)-1;ArrayResize(bytes,len);
   if(CryptEncode(CRYPT_HASH_SHA1,bytes,empty,hash)!=20 || CryptEncode(CRYPT_BASE64,hash,empty,b64)<=0) {WsDrop(index);return false;}
   string accept_key=CharArrayToString(b64,0,ArraySize(b64),CP_UTF8);
   StringReplace(accept_key,"\r","");StringReplace(accept_key,"\n","");
   string response="HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+accept_key+"\r\nSec-WebSocket-Protocol: tongpin-local.v1\r\n\r\n";
   len=StringToCharArray(response,bytes,0,-1,CP_UTF8)-1;ArrayResize(bytes,len);
   if(!WsRaw(index,bytes)) return false;
   g_local_peers[index].origin=origin;g_local_peers[index].upgraded=true;
   RxConsume(index,end);LocalOpened(index);
   return true;
}
bool ValidUtf8(const uchar &bytes[],string &out)
{
   int n=ArraySize(bytes);out=CharArrayToString(bytes,0,n,CP_UTF8);
   uchar roundtrip[];int m=StringToCharArray(out,roundtrip,0,-1,CP_UTF8)-1;
   if(n!=m) return false;
   for(int i=0;i<n;i++) if(bytes[i]!=roundtrip[i]) return false;
   return true;
}
bool WsParseFrame(const int index)
{
   int n=ArraySize(g_local_peers[index].rx);if(n<2) return false;
   uchar first=g_local_peers[index].rx[0],second=g_local_peers[index].rx[1];
   bool fin=(first&128)!=0;uchar opcode=(uchar)(first&15);
   if((first&112)!=0 || (second&128)==0) {WsClose(index,1002);return false;}
   ulong size=(ulong)(second&127);int pos=2;
   if(size==126)
   {
      if(n<4) return false;
      size=(ulong)g_local_peers[index].rx[2]*256+g_local_peers[index].rx[3];pos=4;
      if(size<126) {WsClose(index,1002);return false;}
   }
   else if(size==127)
   {
      if(n<10) return false;
      if((g_local_peers[index].rx[2]&128)!=0) {WsClose(index,1002);return false;}
      size=0;for(int i=2;i<10;i++) size=(size<<8)|g_local_peers[index].rx[i];pos=10;
      if(size<65536) {WsClose(index,1002);return false;}
   }
   if(size>WS_MESSAGE_MAX) {WsClose(index,1009);return false;}
   bool control=opcode>=8;
   if(control && (!fin || size>125)) {WsClose(index,1002);return false;}
   if(n<pos+4+(int)size) return false;
   uchar payload[];ArrayResize(payload,(int)size);
   for(int i=0;i<(int)size;i++) payload[i]=(uchar)(g_local_peers[index].rx[pos+4+i]^g_local_peers[index].rx[pos+i%4]);
   RxConsume(index,pos+4+(int)size);
   if(opcode==8)
   {
      if(size==1) {WsClose(index,1002);return false;}
      if(size>=2)
      {
         int code=(int)payload[0]*256+payload[1];
         if(code<1000 || code>=5000 || code==1004 || code==1005 || code==1006 || code==1015 || (code>=1016 && code<3000)) {WsClose(index,1002);return false;}
         uchar reason[];ArrayCopy(reason,payload,0,2,(int)size-2);string text;
         if(!ValidUtf8(reason,text)) {WsClose(index,1007);return false;}
      }
      WsFrame(index,8,payload);g_local_peers[index].closing=true;return false;
   }
   if(opcode==9) {WsFrame(index,10,payload);return true;}
   if(opcode==10) return true;
   if(opcode==2) {WsClose(index,1003);return false;}
   if(opcode!=0 && opcode!=1) {WsClose(index,1002);return false;}
   if(opcode==1 && g_local_peers[index].fragment_open) {WsClose(index,1002);return false;}
   if(opcode==0 && !g_local_peers[index].fragment_open) {WsClose(index,1002);return false;}
   int total=ArraySize(g_local_peers[index].fragment)+(int)size;
   if(total>WS_MESSAGE_MAX) {WsClose(index,1009);return false;}
   ArrayResize(g_local_peers[index].fragment,total);
   ArrayCopy(g_local_peers[index].fragment,payload,total-(int)size,0,(int)size);
   g_local_peers[index].fragment_open=!fin;
   if(fin)
   {
      string message;
      if(!ValidUtf8(g_local_peers[index].fragment,message)) {WsClose(index,1007);return false;}
      ArrayResize(g_local_peers[index].fragment,0);LocalMessage(index,message);
   }
   return true;
}
bool WsStart(const int port)
{
   for(int i=0;i<LOCAL_PEERS;i++) g_local_peers[i].Reset();
   uchar data[];ArrayResize(data,512);
   if(WSAStartup(0x0202,data)!=0) return false;
   g_winsock_started=true;g_listener=socket(2,1,6);
   if(g_listener==WIN_INVALID_SOCKET) return false;
   uint nonblocking=1;
   if(ioctlsocket(g_listener,(int)0x8004667e,nonblocking)!=0) return false;
   uchar one[];ArrayResize(one,4);ArrayInitialize(one,0);one[0]=1;
   if(setsockopt(g_listener,65535,-5,one,4)!=0) return false; // SO_EXCLUSIVEADDRUSE
   uchar address[];ArrayResize(address,16);ArrayInitialize(address,0);
   address[0]=2;address[2]=(uchar)(port>>8);address[3]=(uchar)port;address[4]=127;address[7]=1;
   return bind(g_listener,address,16)==0 && listen(g_listener,4)==0;
}
void WsStop()
{
   for(int i=0;i<LOCAL_PEERS;i++) WsDrop(i);
   if(g_listener!=WIN_INVALID_SOCKET) closesocket(g_listener);
   g_listener=WIN_INVALID_SOCKET;
   if(g_winsock_started) WSACleanup();g_winsock_started=false;
}
void WsPump(const string allowed_origin,const int port)
{
   for(int attempt=0;attempt<LOCAL_PEERS;attempt++)
   {
      uchar address[];ArrayResize(address,16);int length=16;
      ulong h=accept(g_listener,address,length);
      if(h==WIN_INVALID_SOCKET) break;
      int slot=-1;
      for(int i=0;i<LOCAL_PEERS;i++) if(g_local_peers[i].handle==WIN_INVALID_SOCKET) {slot=i;break;}
      if(slot<0 || length!=16 || address[4]!=127) {closesocket(h);continue;}
      uint nonblocking=1;
      if(ioctlsocket(h,(int)0x8004667e,nonblocking)!=0) {closesocket(h);continue;}
      uchar one[];ArrayResize(one,4);ArrayInitialize(one,0);one[0]=1;
      setsockopt(h,6,1,one,4); // TCP_NODELAY
      g_local_peers[slot].Reset();g_local_peers[slot].handle=h;
      g_local_peers[slot].opened_ms=GetTickCount64();g_local_peers[slot].seen_ms=GetTickCount64();
   }
   for(int i=0;i<LOCAL_PEERS;i++)
   {
      if(g_local_peers[i].handle==WIN_INVALID_SOCKET) continue;
      ulong now=GetTickCount64();
      if((!g_local_peers[i].upgraded && now-g_local_peers[i].opened_ms>5000) || now-g_local_peers[i].seen_ms>90000) {WsDrop(i);continue;}
      if(!g_local_peers[i].closing)
      {
         uchar incoming[];ArrayResize(incoming,8192);
         for(int reads=0;reads<4;reads++)
         {
            int got=recv(g_local_peers[i].handle,incoming,8192,0);
            if(got==0) {WsDrop(i);break;}
            if(got<0) {if(WSAGetLastError()!=10035) WsDrop(i);break;}
            g_local_peers[i].seen_ms=now;
            int count=ArraySize(g_local_peers[i].rx);
            if(count+got>WS_MESSAGE_MAX+8192) {WsClose(i,1009);break;}
            ArrayResize(g_local_peers[i].rx,count+got);ArrayCopy(g_local_peers[i].rx,incoming,count,0,got);
         }
         if(g_local_peers[i].handle==WIN_INVALID_SOCKET) continue;
         if(!g_local_peers[i].upgraded) WsHandshake(i,allowed_origin,port);
         if(g_local_peers[i].handle==WIN_INVALID_SOCKET) continue;
         if(g_local_peers[i].upgraded)
            for(int frames=0;frames<8 && !g_local_peers[i].closing;frames++)
               if(!WsParseFrame(i) || g_local_peers[i].handle==WIN_INVALID_SOCKET) break;
      }
      if(g_local_peers[i].handle==WIN_INVALID_SOCKET) continue;
      int left=ArraySize(g_local_peers[i].tx)-g_local_peers[i].tx_offset;
      if(left>0)
      {
         uchar part[];int chunk=MathMin(left,32768);ArrayCopy(part,g_local_peers[i].tx,0,g_local_peers[i].tx_offset,chunk);
         int wrote=send(g_local_peers[i].handle,part,chunk,0);
         if(wrote>0) g_local_peers[i].tx_offset+=wrote;
         else if(wrote==0 || WSAGetLastError()!=10035) {WsDrop(i);continue;}
      }
      if(g_local_peers[i].tx_offset>=ArraySize(g_local_peers[i].tx))
      {
         ArrayResize(g_local_peers[i].tx,0);g_local_peers[i].tx_offset=0;
         if(g_local_peers[i].closing) WsDrop(i);
      }
   }
}
#endif
