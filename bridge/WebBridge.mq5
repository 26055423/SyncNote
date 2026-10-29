//+------------------------------------------------------------------+
//| WebBridge.mq5                                                    |
//| MT5 side of the EA Bridge. The ONLY component that touches MT5.  |
//|                                                                  |
//| Protocol: see PROTOCOL.md v1. NDJSON over TCP, no DLLs, no       |
//| WebRequest. SocketCreate/Connect/Send/Read only.                 |
//|                                                                  |
//| IMPORTANT:                                                       |
//|  * Attach to a dedicated chart of InpSymbol (one chart/symbol).  |
//|  * Enable "Algo Trading" in the terminal toolbar and allow the   |
//|    EA on the chart. OrderSend will fail otherwise.               |
//|  * Start gateway.py first, then attach.                          |
//|  * This EA does not use MetaTrader5 Python IPC, so no WinError 5.|
//|                                                                  |
//| COMPILE / ATTACH                                                 |
//|  1. In MT5: File > Open Data Folder > MQL5 > Experts.            |
//|  2. Copy this file there (or keep it under the project and use   |
//|     MetaEditor File > Open).                                     |
//|  3. MetaEditor: open WebBridge.mq5 and press F7 (Compile).       |
//|     Expected: 0 errors. Review any warnings on your MT5 build.   |
//|     No includes and no DLLs.                                     |
//|  4. In MT5 enable the "Algo Trading" toolbar button.             |
//|  4b. Add 127.0.0.1 to Tools > Options > Expert Advisors >         |
//|      "Allow ... addresses". Socket* uses the same terminal allow- |
//|      list as WebRequest; this EA still does not call WebRequest.  |
//|  5. Open ONE XAUUSD M1 chart, drag WebBridge onto it, allow       |
//|     algorithmic trading, and set InpToken to the gateway token.  |
//|  6. Do not attach a second copy to another XAUUSD chart.         |
//+------------------------------------------------------------------+
#property copyright "ea_bridge"
#property version   "1.00"
#property strict
#property description "Add 127.0.0.1 to Tools > Options > Expert Advisors > allowed addresses for Socket* connections."

//--- required inputs -------------------------------------------------
input string InpHost            = "127.0.0.1";   // Gateway host
input int    InpPort            = 8788;          // Gateway EA port
input string InpToken           = "change-me-before-use"; // Shared token
input string InpSymbol          = "XAUUSD";      // Dedicated symbol
input bool   InpSendTicks       = true;          // Send ticks
input string InpBarPeriods      = "1m,5m,15m,1h";// Timeframes
input int    InpSnapshotBars    = 500;           // Snapshot bars per TF

//--- operational inputs (safe defaults) ------------------------------
input int    InpMaxTicksPerSecond = 20;          // Tick throttle
input int    InpReconnectMs       = 1000;        // Reconnect backoff
input int    InpMagic             = 0;           // Default magic
input int    InpDeviationPoints   = 20;          // Default slippage

#define PROTOCOL_VERSION 1
#define INVALID_SOCKET   INVALID_HANDLE
#define OUT_QUEUE_MAX    20000
#define RX_MAX_BYTES     2097152

//--- global state ----------------------------------------------------
int      g_socket = INVALID_SOCKET;
bool     g_connected = false;
string   g_rx_buffer = "";
string   g_out_queue[];
int      g_out_head = 0;
int      g_out_count = 0;
bool     g_tick_pending = false;
string   g_tick_json = "";
ulong    g_last_tick_ms = 0;
ulong    g_last_connect_attempt = 0;
int      g_symbol_digits = 5;
int      g_last_server_offset = 0;

ENUM_TIMEFRAMES g_tfs[];
string          g_tf_names[];
datetime        g_bar_times[];
double          g_bar_open[];
double          g_bar_high[];
double          g_bar_low[];
double          g_bar_close[];
long            g_bar_volume[];
int             g_bar_spread[];

// Forward declarations (snapshots are called from ConnectToGateway).
void SendBarsSnapshot();
void SendAccountSnapshot();
void SendPositionsSnapshot();
void SendOrdersSnapshot();
void SendHeartbeat();

//+------------------------------------------------------------------+
//| Helpers: JSON                                                    |
//+------------------------------------------------------------------+
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

int JsonValuePos(const string js, const string key)
{
   string needle = "\"" + key + "\"";
   int pos = StringFind(js, needle);
   if(pos < 0)
      return -1;
   int len = StringLen(js);
   pos += StringLen(needle);
   while(pos < len)
   {
      ushort c = StringGetCharacter(js, pos);
      if(c == ' ' || c == '\t' || c == '\r' || c == '\n')
         pos++;
      else
         break;
   }
   if(pos >= len || StringGetCharacter(js, pos) != ':')
      return -1;
   pos++;
   while(pos < len)
   {
      ushort c = StringGetCharacter(js, pos);
      if(c == ' ' || c == '\t' || c == '\r' || c == '\n')
         pos++;
      else
         break;
   }
   return pos;
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

//+------------------------------------------------------------------+
//| Helpers: retcodes / prices / volume                              |
//+------------------------------------------------------------------+
string RetcodeName(const long code)
{
   switch((int)code)
   {
      case 10004: return "TRADE_RETCODE_REQUOTE";
      case 10006: return "TRADE_RETCODE_REJECT";
      case 10007: return "TRADE_RETCODE_CANCEL";
      case 10008: return "TRADE_RETCODE_PLACED";
      case 10009: return "TRADE_RETCODE_DONE";
      case 10010: return "TRADE_RETCODE_DONE_PARTIAL";
      case 10011: return "TRADE_RETCODE_ERROR";
      case 10012: return "TRADE_RETCODE_TIMEOUT";
      case 10013: return "TRADE_RETCODE_INVALID";
      case 10014: return "TRADE_RETCODE_INVALID_VOLUME";
      case 10015: return "TRADE_RETCODE_INVALID_PRICE";
      case 10016: return "TRADE_RETCODE_INVALID_STOPS";
      case 10017: return "TRADE_RETCODE_TRADE_DISABLED";
      case 10018: return "TRADE_RETCODE_MARKET_CLOSED";
      case 10019: return "TRADE_RETCODE_NO_MONEY";
      case 10020: return "TRADE_RETCODE_PRICE_CHANGED";
      case 10021: return "TRADE_RETCODE_PRICE_OFF";
      case 10022: return "TRADE_RETCODE_INVALID_EXPIRATION";
      case 10023: return "TRADE_RETCODE_ORDER_CHANGED";
      case 10024: return "TRADE_RETCODE_TOO_MANY_REQUESTS";
      case 10025: return "TRADE_RETCODE_NO_CHANGES";
      case 10026: return "TRADE_RETCODE_SERVER_DISABLES_AT";
      case 10027: return "TRADE_RETCODE_CLIENT_DISABLES_AT";
      case 10028: return "TRADE_RETCODE_LOCKED";
      case 10029: return "TRADE_RETCODE_FROZEN";
      case 10030: return "TRADE_RETCODE_INVALID_FILL";
      case 10031: return "TRADE_RETCODE_CONNECTION";
      case 10032: return "TRADE_RETCODE_ONLY_REAL";
      case 10033: return "TRADE_RETCODE_LIMIT_ORDERS";
      case 10034: return "TRADE_RETCODE_LIMIT_VOLUME";
      case 10035: return "TRADE_RETCODE_INVALID_ORDER";
      case 10036: return "TRADE_RETCODE_POSITION_CLOSED";
      case 10038: return "TRADE_RETCODE_INVALID_CLOSE_VOLUME";
      case 10039: return "TRADE_RETCODE_CLOSE_ORDER_EXIST";
      case 10040: return "TRADE_RETCODE_LIMIT_POSITIONS";
      case 10041: return "TRADE_RETCODE_REJECT_CANCEL";
      case 10042: return "TRADE_RETCODE_LONG_ONLY";
      case 10043: return "TRADE_RETCODE_SHORT_ONLY";
      case 10044: return "TRADE_RETCODE_CLOSE_ONLY";
      case 10045: return "TRADE_RETCODE_FIFO_CLOSE";
      case 10046: return "TRADE_RETCODE_HEDGE_PROHIBITED";
      case 10047: return "TRADE_RETCODE_PROHIBIT_EMPTY_DEALS";
      default:    return "TRADE_RETCODE_UNKNOWN";
   }
}

bool IsSuccessRetcode(const long code)
{
   return (code == 10008 || code == 10009 || code == 10010);
}

double NormPrice(const double price)
{
   return NormalizeDouble(price, g_symbol_digits);
}

bool NormalizeVolume(const double requested, double &out)
{
   double minv = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MIN);
   double maxv = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_STEP);
   if(requested <= 0.0)
      return false;
   if(step <= 0.0)
      step = 0.01;
   double v = MathRound(requested / step) * step;
   if(v < minv - 1e-9 || v > maxv + 1e-9)
      return false;
   out = NormalizeDouble(v, 8);
   return out > 0.0;
}

string NormalizeComment(const string comment)
{
   if(StringLen(comment) <= 31)
      return comment;
   return StringSubstr(comment, 0, 31);
}

//+------------------------------------------------------------------+
//| Result and event builders                                        |
//+------------------------------------------------------------------+
bool QueueCritical(const string line);
void FlushOutgoing(const int max_messages);
void MarkDisconnected(const string reason);

void SendResult(const string id, const bool ok, const long retcode,
                const ulong order, const ulong deal, const double price,
                const double volume, const string error)
{
   string js = "{" +
               JKey("v") + IntegerToString(PROTOCOL_VERSION) + "," +
               JKey("type") + JStr("result") + "," +
               JKey("id") + JStr(id) + "," +
               JKey("ok") + (ok ? "true" : "false") + "," +
               JKey("retcode") + JLong(retcode) + "," +
               JKey("retcode_name") + JStr(RetcodeName(retcode)) + "," +
               JKey("order") + IntegerToString((long)order) + "," +
               JKey("deal") + IntegerToString((long)deal) + "," +
               JKey("price") + JNum(price, g_symbol_digits) + "," +
               JKey("volume") + JNum(volume, 2) + "," +
               JKey("error") + JStr(error) +
               "}";
   QueueCritical(js);
   FlushOutgoing(16);
}

void SendLocalResult(const string id, const long retcode, const string error)
{
   SendResult(id, false, retcode, 0, 0, 0.0, 0.0, error);
}

//+------------------------------------------------------------------+
//| Helpers: socket write / read                                     |
//+------------------------------------------------------------------+
bool SendRaw(const string line)
{
   if(!g_connected || g_socket == INVALID_SOCKET)
      return false;

   string payload = line;
   int payload_len = StringLen(payload);
   if(payload_len == 0 || StringGetCharacter(payload, payload_len - 1) != '\n')
      payload += "\n";

   uchar bytes[];
   int len = StringToCharArray(payload, bytes, 0, -1, CP_UTF8);
   if(len > 0 && bytes[len - 1] == 0)
      len--;
   if(len <= 0)
      return true;

   int total = 0;
   while(total < len)
   {
      uchar part[];
      int remaining = len - total;
      ArrayResize(part, remaining);
      ArrayCopy(part, bytes, 0, total, remaining);
      int sent = SocketSend(g_socket, part, remaining);
      if(sent <= 0)
      {
         Print("WebBridge: SocketSend failed, error=", GetLastError());
         return false;
      }
      total += sent;
   }
   return true;
}

bool ReadSocketAvailable()
{
   if(!g_connected || g_socket == INVALID_SOCKET)
      return false;
   uint available = SocketIsReadable(g_socket);
   if(available == 0)
      return false;
   uchar buffer[];
   int want = (int)MathMin((uint)8192, available);
   ArrayResize(buffer, want);
   int received = SocketRead(g_socket, buffer, want, 0);
   if(received <= 0)
   {
      if(received < 0)
         Print("WebBridge: SocketRead failed, error=", GetLastError());
      return false;
   }
   string chunk = CharArrayToString(buffer, 0, received, CP_UTF8);
   g_rx_buffer += chunk;
   if(StringLen(g_rx_buffer) > RX_MAX_BYTES)
   {
      Print("WebBridge: receive buffer exceeded limit");
      g_rx_buffer = "";
      return false;
   }
   return true;
}

bool ExtractLine(string &line)
{
   int pos = StringFind(g_rx_buffer, "\n");
   if(pos < 0)
      return false;
   line = StringSubstr(g_rx_buffer, 0, pos);
   g_rx_buffer = StringSubstr(g_rx_buffer, pos + 1);
   int len = StringLen(line);
   if(len > 0 && StringGetCharacter(line, len - 1) == '\r')
      line = StringSubstr(line, 0, len - 1);
   return true;
}

//+------------------------------------------------------------------+
//| Handshake                                                        |
//+------------------------------------------------------------------+
string ServerOffsetString()
{
   long offset = (long)TimeTradeServer() - (long)TimeGMT();
   return IntegerToString(offset);
}

bool WaitForHelloAck(const int timeout_ms)
{
   ulong deadline = GetTickCount64() + (ulong)timeout_ms;
   while(GetTickCount64() < deadline)
   {
      string line;
      while(ExtractLine(line))
      {
         string typ = "";
         if(!JsonGetString(line, "type", typ) || typ != "hello_ack")
            continue;
         bool ok = false;
         if(!JsonGetBool(line, "ok", ok))
            return false;
         if(!ok)
         {
            string err = "";
            JsonGetString(line, "error", err);
            Print("WebBridge: handshake rejected: ", err);
         }
         return ok;
      }
      ReadSocketAvailable();
      Sleep(10);
   }
   Print("WebBridge: handshake ack timeout");
   return false;
}

bool ConnectToGateway()
{
   if(g_connected)
      return true;
   if(InpPort <= 0 || InpPort > 65535)
   {
      Print("WebBridge: invalid InpPort");
      return false;
   }
   g_socket = SocketCreate();
   if(g_socket == INVALID_SOCKET)
   {
      Print("WebBridge: SocketCreate failed, error=", GetLastError());
      return false;
   }
   if(!SocketConnect(g_socket, InpHost, (uint)InpPort, 3000))
   {
      int err = GetLastError();
      Print("WebBridge: SocketConnect failed, error=", err,
            (err == 5272 ? " (allow 127.0.0.1 in Tools > Options > Expert Advisors)" : ""));
      SocketClose(g_socket);
      g_socket = INVALID_SOCKET;
      return false;
   }
   // Bound OS-level read/write blocking even if the gateway stalls.
   SocketTimeouts(g_socket, 1000, 1000);

   g_connected = true;
   g_rx_buffer = "";
   g_last_server_offset = (int)((long)TimeTradeServer() - (long)TimeGMT());

   string hello = "{" +
                  JKey("v") + IntegerToString(PROTOCOL_VERSION) + "," +
                  JKey("type") + JStr("hello") + "," +
                  JKey("token") + JStr(InpToken) + "," +
                  JKey("terminal") + JStr(TerminalInfoString(TERMINAL_NAME)) + "," +
                  JKey("symbol") + JStr(InpSymbol) + "," +
                  JKey("server_offset_sec") + IntegerToString(g_last_server_offset) + "," +
                  JKey("time") + IntegerToString((long)TimeCurrent()) +
                  "}";
   if(!SendRaw(hello))
   {
      MarkDisconnected("hello send failed");
      return false;
   }
   if(!WaitForHelloAck(3000))
   {
      g_rx_buffer = "";
      MarkDisconnected("handshake failed");
      return false;
   }

   Print("WebBridge: connected to ", InpHost, ":", InpPort, " symbol=", InpSymbol);
   g_rx_buffer = "";
   SendBarsSnapshot();
   SendAccountSnapshot();
   SendPositionsSnapshot();
   SendOrdersSnapshot();
   SendHeartbeat();
   FlushOutgoing(10000);
   return g_connected;
}

void MarkDisconnected(const string reason)
{
   if(g_connected)
      Print("WebBridge: disconnected: ", reason);
   g_connected = false;
   if(g_socket != INVALID_SOCKET)
   {
      SocketClose(g_socket);
      g_socket = INVALID_SOCKET;
   }
   g_rx_buffer = "";
   g_tick_pending = false;
   g_tick_json = "";
   g_out_head = 0;
   g_out_count = 0;
   ArrayResize(g_out_queue, 2048);
}

//+------------------------------------------------------------------+
//| Outgoing queue: ticks are coalesced, critical data is kept        |
//+------------------------------------------------------------------+
bool QueueCritical(const string line)
{
   if(!g_connected)
      return false;
   if(g_out_count >= OUT_QUEUE_MAX)
   {
      Print("WebBridge: outbound queue overflow; forcing reconnect");
      MarkDisconnected("outbound queue overflow");
      return false;
   }
   if(g_out_head + g_out_count >= ArraySize(g_out_queue))
   {
      if(g_out_head > 0)
      {
         for(int i = 0; i < g_out_count; i++)
            g_out_queue[i] = g_out_queue[g_out_head + i];
         g_out_head = 0;
      }
      int want = g_out_count + 2048;
      if(want > OUT_QUEUE_MAX)
         want = OUT_QUEUE_MAX;
      if(ArrayResize(g_out_queue, want) < 0)
      {
         MarkDisconnected("outbound array resize failed");
         return false;
      }
   }
   g_out_queue[g_out_head + g_out_count] = line;
   g_out_count++;
   return true;
}

void QueueLatestTick(const string line)
{
   g_tick_json = line;
   g_tick_pending = true;
}

void FlushOutgoing(const int max_messages)
{
   if(!g_connected)
      return;
   int sent = 0;
   while(g_out_count > 0 && sent < max_messages && g_connected)
   {
      string line = g_out_queue[g_out_head];
      g_out_queue[g_out_head] = "";
      g_out_head++;
      g_out_count--;
      if(!SendRaw(line))
      {
         MarkDisconnected("SocketSend failed");
         return;
      }
      sent++;
   }
   if(g_tick_pending && sent < max_messages && g_connected)
   {
      if(SendRaw(g_tick_json))
         g_tick_pending = false;
      else
      {
         MarkDisconnected("tick send failed");
         return;
      }
   }
   if(g_out_count == 0)
   {
      g_out_head = 0;
      if(ArraySize(g_out_queue) > 4096)
         ArrayResize(g_out_queue, 2048);
   }
}

//+------------------------------------------------------------------+
//| Snapshot builders                                                |
//+------------------------------------------------------------------+
string BarJson(const ENUM_TIMEFRAMES tf, const string tf_name,
               const datetime bar_time, const double o, const double h,
               const double l, const double c, const long tick_volume,
               const int spread, const bool closed)
{
   return "{" +
          JKey("v") + IntegerToString(PROTOCOL_VERSION) + "," +
          JKey("type") + JStr("bar") + "," +
          JKey("symbol") + JStr(InpSymbol) + "," +
          JKey("tf") + JStr(tf_name) + "," +
          JKey("bar_time") + IntegerToString((long)bar_time) + "," +
          JKey("open") + JNum(o, g_symbol_digits) + "," +
          JKey("high") + JNum(h, g_symbol_digits) + "," +
          JKey("low") + JNum(l, g_symbol_digits) + "," +
          JKey("close") + JNum(c, g_symbol_digits) + "," +
          JKey("tick_volume") + JLong(tick_volume) + "," +
          JKey("spread") + IntegerToString(spread) + "," +
          JKey("closed") + (closed ? "true" : "false") +
          "}";
}

void CacheBar(const int index, const MqlRates &rate)
{
   g_bar_times[index] = rate.time;
   g_bar_open[index] = rate.open;
   g_bar_high[index] = rate.high;
   g_bar_low[index] = rate.low;
   g_bar_close[index] = rate.close;
   g_bar_volume[index] = rate.tick_volume;
   g_bar_spread[index] = rate.spread;
}

void ResetBarCaches()
{
   int count = ArraySize(g_tfs);
   ArrayResize(g_bar_times, count);
   ArrayResize(g_bar_open, count);
   ArrayResize(g_bar_high, count);
   ArrayResize(g_bar_low, count);
   ArrayResize(g_bar_close, count);
   ArrayResize(g_bar_volume, count);
   ArrayResize(g_bar_spread, count);
   for(int i = 0; i < count; i++)
   {
      g_bar_times[i] = 0;
      g_bar_open[i] = 0;
      g_bar_high[i] = 0;
      g_bar_low[i] = 0;
      g_bar_close[i] = 0;
      g_bar_volume[i] = 0;
      g_bar_spread[i] = 0;
   }
}

void SendBarsSnapshot()
{
   int count = ArraySize(g_tfs);
   int bars = InpSnapshotBars;
   if(bars < 1)
      bars = 1;
   if(bars > 5000)
      bars = 5000;
   for(int i = 0; i < count; i++)
   {
      MqlRates rates[];
      int copied = CopyRates(InpSymbol, g_tfs[i], 0, bars, rates);
      if(copied <= 0)
      {
         Print("WebBridge: CopyRates failed for ", g_tf_names[i], ", error=", GetLastError());
         continue;
      }
      datetime latest_time = 0;
      MqlRates latest;
      ZeroMemory(latest);
      for(int j = 0; j < copied; j++)
      {
         bool closed = (rates[j].time + PeriodSeconds(g_tfs[i]) <= TimeCurrent());
         QueueCritical(BarJson(g_tfs[i], g_tf_names[i], rates[j].time,
                               rates[j].open, rates[j].high, rates[j].low, rates[j].close,
                               rates[j].tick_volume, rates[j].spread, closed));
         if(rates[j].time >= latest_time)
         {
            latest_time = rates[j].time;
            latest = rates[j];
         }
      }
      if(latest_time > 0)
         CacheBar(i, latest);
   }
}

void SendBarsUpdate()
{
   int count = ArraySize(g_tfs);
   for(int i = 0; i < count; i++)
   {
      MqlRates rate[];
      if(CopyRates(InpSymbol, g_tfs[i], 0, 1, rate) != 1)
         continue;
      datetime bar_time = rate[0].time;
      if(g_bar_times[i] == 0)
      {
         CacheBar(i, rate[0]);
         QueueCritical(BarJson(g_tfs[i], g_tf_names[i], bar_time, rate[0].open, rate[0].high,
                               rate[0].low, rate[0].close, rate[0].tick_volume, rate[0].spread, false));
         continue;
      }
      if(bar_time != g_bar_times[i])
      {
         bool previous_closed = (g_bar_times[i] + PeriodSeconds(g_tfs[i]) <= TimeCurrent());
         QueueCritical(BarJson(g_tfs[i], g_tf_names[i], g_bar_times[i], g_bar_open[i], g_bar_high[i],
                               g_bar_low[i], g_bar_close[i], g_bar_volume[i], g_bar_spread[i], previous_closed));
         CacheBar(i, rate[0]);
         QueueCritical(BarJson(g_tfs[i], g_tf_names[i], bar_time, rate[0].open, rate[0].high,
                               rate[0].low, rate[0].close, rate[0].tick_volume, rate[0].spread, false));
         continue;
      }
      bool changed = (rate[0].open != g_bar_open[i] ||
                      rate[0].high != g_bar_high[i] ||
                      rate[0].low != g_bar_low[i] ||
                      rate[0].close != g_bar_close[i] ||
                      rate[0].tick_volume != g_bar_volume[i] ||
                      rate[0].spread != g_bar_spread[i]);
      if(changed)
      {
         CacheBar(i, rate[0]);
         QueueCritical(BarJson(g_tfs[i], g_tf_names[i], bar_time, rate[0].open, rate[0].high,
                               rate[0].low, rate[0].close, rate[0].tick_volume, rate[0].spread, false));
      }
   }
}

void SendAccountSnapshot()
{
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double margin = AccountInfoDouble(ACCOUNT_MARGIN);
   double free_margin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double profit = AccountInfoDouble(ACCOUNT_PROFIT);
   string js = "{" +
               JKey("v") + IntegerToString(PROTOCOL_VERSION) + "," +
               JKey("type") + JStr("account") + "," +
               JKey("login") + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "," +
               JKey("balance") + JNum(balance, 2) + "," +
               JKey("equity") + JNum(equity, 2) + "," +
               JKey("margin") + JNum(margin, 2) + "," +
               JKey("free_margin") + JNum(free_margin, 2) + "," +
               JKey("currency") + JStr(AccountInfoString(ACCOUNT_CURRENCY)) + "," +
               JKey("leverage") + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) + "," +
               JKey("profit") + JNum(profit, 2) +
               "}";
   QueueCritical(js);
}

string PositionJson(const ulong ticket)
{
   if(!PositionSelectByTicket(ticket))
      return "";
   if(PositionGetString(POSITION_SYMBOL) != InpSymbol)
      return "";
   long type = PositionGetInteger(POSITION_TYPE);
   string side = (type == POSITION_TYPE_BUY ? "buy" : "sell");
   long time_msc = (long)PositionGetInteger(POSITION_TIME) * 1000;
   return "{" +
          JKey("ticket") + IntegerToString((long)ticket) + "," +
          JKey("symbol") + JStr(InpSymbol) + "," +
          JKey("side") + JStr(side) + "," +
          JKey("volume") + JNum(PositionGetDouble(POSITION_VOLUME), 2) + "," +
          JKey("price_open") + JNum(PositionGetDouble(POSITION_PRICE_OPEN), g_symbol_digits) + "," +
          JKey("sl") + JNum(PositionGetDouble(POSITION_SL), g_symbol_digits) + "," +
          JKey("tp") + JNum(PositionGetDouble(POSITION_TP), g_symbol_digits) + "," +
          JKey("profit") + JNum(PositionGetDouble(POSITION_PROFIT), 2) + "," +
          JKey("magic") + IntegerToString(PositionGetInteger(POSITION_MAGIC)) + "," +
          JKey("comment") + JStr(PositionGetString(POSITION_COMMENT)) + "," +
          JKey("time_msc") + JLong(time_msc) +
          "}";
}

void SendPositionsSnapshot()
{
   string items = "";
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      string item = PositionJson(ticket);
      if(item == "")
         continue;
      if(items != "")
         items += ",";
      items += item;
   }
   QueueCritical("{" + JKey("v") + IntegerToString(PROTOCOL_VERSION) + "," +
                 JKey("type") + JStr("positions") + "," +
                 JKey("items") + "[" + items + "]}");
}

string OrderTypeName(const long type)
{
   switch((int)type)
   {
      case ORDER_TYPE_BUY_LIMIT:  return "buy_limit";
      case ORDER_TYPE_SELL_LIMIT: return "sell_limit";
      case ORDER_TYPE_BUY_STOP:   return "buy_stop";
      case ORDER_TYPE_SELL_STOP:  return "sell_stop";
      case ORDER_TYPE_BUY_STOP_LIMIT:  return "buy_stop_limit";
      case ORDER_TYPE_SELL_STOP_LIMIT: return "sell_stop_limit";
      default: return "other";
   }
}

string OrderSideName(const long type)
{
   if(type == ORDER_TYPE_BUY || type == ORDER_TYPE_BUY_LIMIT ||
      type == ORDER_TYPE_BUY_STOP || type == ORDER_TYPE_BUY_STOP_LIMIT)
      return "buy";
   return "sell";
}

string OrderStateName(const long state)
{
   switch((int)state)
   {
      case ORDER_STATE_PLACED:  return "placed";
      case ORDER_STATE_PARTIAL: return "partial";
      case ORDER_STATE_CANCELED:return "canceled";
      case ORDER_STATE_FILLED:  return "filled";
      case ORDER_STATE_REJECTED:return "rejected";
      case ORDER_STATE_EXPIRED: return "expired";
      default: return "unknown";
   }
}

string OrderJson(const ulong ticket)
{
   if(!OrderSelect(ticket))
      return "";
   if(OrderGetString(ORDER_SYMBOL) != InpSymbol)
      return "";
   long type = OrderGetInteger(ORDER_TYPE);
   long time_msc = (long)OrderGetInteger(ORDER_TIME_SETUP) * 1000;
   return "{" +
          JKey("ticket") + IntegerToString((long)ticket) + "," +
          JKey("symbol") + JStr(InpSymbol) + "," +
          JKey("type") + JStr(OrderTypeName(type)) + "," +
          JKey("side") + JStr(OrderSideName(type)) + "," +
          JKey("volume") + JNum(OrderGetDouble(ORDER_VOLUME_CURRENT), 2) + "," +
          JKey("price") + JNum(OrderGetDouble(ORDER_PRICE_OPEN), g_symbol_digits) + "," +
          JKey("sl") + JNum(OrderGetDouble(ORDER_SL), g_symbol_digits) + "," +
          JKey("tp") + JNum(OrderGetDouble(ORDER_TP), g_symbol_digits) + "," +
          JKey("magic") + IntegerToString(OrderGetInteger(ORDER_MAGIC)) + "," +
          JKey("comment") + JStr(OrderGetString(ORDER_COMMENT)) + "," +
          JKey("time_msc") + JLong(time_msc) + "," +
          JKey("state") + JStr(OrderStateName(OrderGetInteger(ORDER_STATE))) +
          "}";
}

void SendOrdersSnapshot()
{
   string items = "";
   int total = OrdersTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0)
         continue;
      string item = OrderJson(ticket);
      if(item == "")
         continue;
      if(items != "")
         items += ",";
      items += item;
   }
   QueueCritical("{" + JKey("v") + IntegerToString(PROTOCOL_VERSION) + "," +
                 JKey("type") + JStr("orders") + "," +
                 JKey("items") + "[" + items + "]}");
}

void SendHeartbeat()
{
   g_last_server_offset = (int)((long)TimeTradeServer() - (long)TimeGMT());
   QueueCritical("{" + JKey("v") + IntegerToString(PROTOCOL_VERSION) + "," +
                 JKey("type") + JStr("heartbeat") + "," +
                 JKey("time") + IntegerToString((long)TimeCurrent()) + "," +
                 JKey("server_offset_sec") + IntegerToString(g_last_server_offset) +
                 "}");
}

//+------------------------------------------------------------------+
//| Trade command helpers                                            |
//|                                                                  |
//| MQL5 has no MQL4-style OrderModify/OrderDelete/PositionClose      |
//| functions. The equivalent operations are OrderSend with          |
//| TRADE_ACTION_MODIFY / TRADE_ACTION_REMOVE / TRADE_ACTION_DEAL.    |
//| This EA uses those native MQL5 requests; do not replace them with |
//| MQL4 snippets.                                                   |
//+------------------------------------------------------------------+
void AddFill(int &fills[], const int value)
{
   int count = ArraySize(fills);
   for(int i = 0; i < count; i++)
      if(fills[i] == value)
         return;
   ArrayResize(fills, count + 1);
   fills[count] = value;
}

void BuildFillCandidates(const bool market, int &fills[])
{
   ArrayResize(fills, 0);
   long mode = SymbolInfoInteger(InpSymbol, SYMBOL_FILLING_MODE);
   bool fok = ((mode & 1) != 0);   // SYMBOL_FILLING_FOK
   bool ioc = ((mode & 2) != 0);   // SYMBOL_FILLING_IOC
   if(market)
   {
      if(ioc) AddFill(fills, ORDER_FILLING_IOC);
      if(fok) AddFill(fills, ORDER_FILLING_FOK);
      AddFill(fills, ORDER_FILLING_RETURN);
   }
   else
   {
      AddFill(fills, ORDER_FILLING_RETURN);
      if(ioc) AddFill(fills, ORDER_FILLING_IOC);
      if(fok) AddFill(fills, ORDER_FILLING_FOK);
   }
}

bool SendWithFillFallback(MqlTradeRequest &request, MqlTradeResult &result)
{
   int fills[];
   bool market = (request.action == TRADE_ACTION_DEAL);
   BuildFillCandidates(market, fills);
   for(int i = 0; i < ArraySize(fills); i++)
   {
      request.type_filling = (ENUM_ORDER_TYPE_FILLING)fills[i];
      ZeroMemory(result);
      bool sent = OrderSend(request, result);
      if(result.retcode != 10030)   // TRADE_RETCODE_INVALID_FILL
         return sent;
      Print("WebBridge: broker rejected filling mode ", fills[i], ", trying next");
   }
   return false;
}

void SendTradeResultFromSend(const string id, const MqlTradeResult &result)
{
   bool ok = IsSuccessRetcode(result.retcode);
   string error = result.comment;
   if(error == "")
      error = (ok ? "" : "OrderSend failed");
   SendResult(id, ok, result.retcode, result.order, result.deal, result.price, result.volume, error);
}

void HandleOrderCommand(const string line)
{
   string id = "";
   if(!JsonGetString(line, "id", id) || id == "")
      return;
   string action = "";
   string side = "";
   string symbol = "";
   JsonGetString(line, "action", action);
   JsonGetString(line, "side", side);
   JsonGetString(line, "symbol", symbol);
   StringToLower(action);
   StringToLower(side);
   if(symbol == "")
      symbol = InpSymbol;
   if(symbol != InpSymbol)
   {
      SendLocalResult(id, 10013, "symbol not allowed by this EA");
      return;
   }
   if(action != "market" && action != "limit" && action != "stop")
   {
      SendLocalResult(id, 10013, "action must be market, limit or stop");
      return;
   }
   if(side != "buy" && side != "sell")
   {
      SendLocalResult(id, 10013, "side must be buy or sell");
      return;
   }

   double requested_volume = 0.0;
   double volume = 0.0;
   if(!JsonGetDouble(line, "volume", requested_volume) || !NormalizeVolume(requested_volume, volume))
   {
      SendLocalResult(id, 10014, "invalid volume");
      return;
   }

   double price = 0.0;
   double sl = 0.0;
   double tp = 0.0;
   double deviation = InpDeviationPoints;
   long magic = InpMagic;
   string comment = "ea_bridge";
   JsonGetDouble(line, "price", price);
   JsonGetDouble(line, "sl", sl);
   JsonGetDouble(line, "tp", tp);
   JsonGetDouble(line, "deviation", deviation);
   JsonGetLong(line, "magic", magic);
   JsonGetString(line, "comment", comment);
   comment = NormalizeComment(comment);
   if(deviation < 0)
      deviation = 0;
   if(deviation > 10000)
      deviation = 10000;

   MqlTick tick;
   if(!SymbolInfoTick(InpSymbol, tick))
   {
      SendLocalResult(id, 10013, "no current tick");
      return;
   }

   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   bool buy = (side == "buy");
   if(action == "market")
   {
      request.action = TRADE_ACTION_DEAL;
      request.type = (buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL);
      request.price = NormPrice(buy ? tick.ask : tick.bid);
   }
   else
   {
      request.action = TRADE_ACTION_PENDING;
      if(action == "limit")
         request.type = (buy ? ORDER_TYPE_BUY_LIMIT : ORDER_TYPE_SELL_LIMIT);
      else
         request.type = (buy ? ORDER_TYPE_BUY_STOP : ORDER_TYPE_SELL_STOP);
      if(price <= 0.0)
      {
         SendLocalResult(id, 10015, "price required for limit/stop");
         return;
      }
      request.price = NormPrice(price);
      if(sl > 0.0 && ((buy && sl >= request.price) || (!buy && sl <= request.price)))
      {
         SendLocalResult(id, 10016, "invalid stop loss side");
         return;
      }
      if(tp > 0.0 && ((buy && tp <= request.price) || (!buy && tp >= request.price)))
      {
         SendLocalResult(id, 10016, "invalid take profit side");
         return;
      }
   }

   request.symbol = InpSymbol;
   request.volume = volume;
   request.sl = (sl > 0.0 ? NormPrice(sl) : 0.0);
   request.tp = (tp > 0.0 ? NormPrice(tp) : 0.0);
   request.deviation = (ulong)deviation;
   request.magic = (ulong)magic;
   request.comment = comment;
   request.type_time = ORDER_TIME_GTC;
   request.expiration = 0;
   request.type_filling = ORDER_FILLING_RETURN;

   bool sent = SendWithFillFallback(request, result);
   if(!sent && result.retcode == 0)
      result.retcode = 10013;
   if(result.comment == "" && result.retcode == 0)
      result.comment = "OrderSend failed, error=" + IntegerToString(GetLastError());
   SendTradeResultFromSend(id, result);
}

void HandleCancelCommand(const string line)
{
   string id = "";
   if(!JsonGetString(line, "id", id) || id == "")
      return;
   long ticket = 0;
   JsonGetLong(line, "order_ticket", ticket);
   if(ticket <= 0)
   {
      SendLocalResult(id, 10013, "order_ticket required");
      return;
   }
   if(!OrderSelect((ulong)ticket))
   {
      SendLocalResult(id, 10013, "pending order not found");
      return;
   }
   if(OrderGetString(ORDER_SYMBOL) != InpSymbol)
   {
      SendLocalResult(id, 10013, "order is not on this EA's symbol");
      return;
   }
   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);
   request.action = TRADE_ACTION_REMOVE;
   request.order = (ulong)ticket;
   request.symbol = InpSymbol;
   bool sent = OrderSend(request, result);
   if(!sent && result.retcode == 0)
      result.retcode = 10013;
   if(result.comment == "")
      result.comment = (sent ? "" : "OrderDelete equivalent failed");
   SendTradeResultFromSend(id, result);
}

void HandleCloseCommand(const string line)
{
   string id = "";
   if(!JsonGetString(line, "id", id) || id == "")
      return;
   long ticket = 0;
   JsonGetLong(line, "position_ticket", ticket);
   if(ticket <= 0)
   {
      SendLocalResult(id, 10013, "position_ticket required");
      return;
   }
   if(!PositionSelectByTicket((ulong)ticket))
   {
      SendLocalResult(id, 10036, "position not found or already closed");
      return;
   }
   if(PositionGetString(POSITION_SYMBOL) != InpSymbol)
   {
      SendLocalResult(id, 10013, "position is not on this EA's symbol");
      return;
   }
   long position_type = PositionGetInteger(POSITION_TYPE);
   double current_volume = PositionGetDouble(POSITION_VOLUME);
   double requested = 0.0;
   double volume = current_volume;
   if(JsonGetDouble(line, "volume", requested) && requested > 0.0)
   {
      if(requested > current_volume + 1e-9)
      {
         SendLocalResult(id, 10038, "close volume exceeds position volume");
         return;
      }
      if(!NormalizeVolume(requested, volume))
      {
         SendLocalResult(id, 10014, "invalid close volume");
         return;
      }
   }
   MqlTick tick;
   if(!SymbolInfoTick(InpSymbol, tick))
   {
      SendLocalResult(id, 10013, "no current tick");
      return;
   }
   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);
   request.action = TRADE_ACTION_DEAL;
   request.position = (ulong)ticket;
   request.symbol = InpSymbol;
   request.volume = volume;
   request.type = (position_type == POSITION_TYPE_BUY ? ORDER_TYPE_SELL : ORDER_TYPE_BUY);
   request.price = NormPrice(position_type == POSITION_TYPE_BUY ? tick.bid : tick.ask);
   request.deviation = (ulong)InpDeviationPoints;
   request.magic = (ulong)PositionGetInteger(POSITION_MAGIC);
   request.comment = "ea_bridge_close";
   request.type_time = ORDER_TIME_GTC;
   request.type_filling = ORDER_FILLING_RETURN;
   bool sent = SendWithFillFallback(request, result);
   if(!sent && result.retcode == 0)
      result.retcode = 10013;
   if(result.comment == "")
      result.comment = (sent ? "" : "PositionClose equivalent failed");
   SendTradeResultFromSend(id, result);
}

void HandleModifyCommand(const string line)
{
   string id = "";
   if(!JsonGetString(line, "id", id) || id == "")
      return;
   long ticket = 0;
   JsonGetLong(line, "ticket", ticket);
   if(ticket <= 0)
   {
      SendLocalResult(id, 10013, "ticket required");
      return;
   }
   double sl = 0.0;
   double tp = 0.0;
   JsonGetDouble(line, "sl", sl);
   JsonGetDouble(line, "tp", tp);
   if(sl < 0.0 || tp < 0.0)
   {
      SendLocalResult(id, 10016, "sl/tp must be non-negative");
      return;
   }

   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   if(PositionSelectByTicket((ulong)ticket))
   {
      if(PositionGetString(POSITION_SYMBOL) != InpSymbol)
      {
         SendLocalResult(id, 10013, "position is not on this EA's symbol");
         return;
      }
      request.action = TRADE_ACTION_SLTP;
      request.position = (ulong)ticket;
      request.symbol = InpSymbol;
      request.sl = (sl > 0.0 ? NormPrice(sl) : 0.0);
      request.tp = (tp > 0.0 ? NormPrice(tp) : 0.0);
      bool sent = OrderSend(request, result);
      if(!sent && result.retcode == 0)
         result.retcode = 10013;
      if(result.comment == "")
         result.comment = (sent ? "" : "PositionModify equivalent failed");
      SendTradeResultFromSend(id, result);
      return;
   }

   if(OrderSelect((ulong)ticket))
   {
      if(OrderGetString(ORDER_SYMBOL) != InpSymbol)
      {
         SendLocalResult(id, 10013, "order is not on this EA's symbol");
         return;
      }
      request.action = TRADE_ACTION_MODIFY;
      request.order = (ulong)ticket;
      request.symbol = InpSymbol;
      request.price = OrderGetDouble(ORDER_PRICE_OPEN);
      request.sl = (sl > 0.0 ? NormPrice(sl) : 0.0);
      request.tp = (tp > 0.0 ? NormPrice(tp) : 0.0);
      request.type_time = ORDER_TIME_GTC;
      request.expiration = 0;
      bool sent = SendWithFillFallback(request, result);
      if(!sent && result.retcode == 0)
         result.retcode = 10013;
      if(result.comment == "")
         result.comment = (sent ? "" : "OrderModify equivalent failed");
      SendTradeResultFromSend(id, result);
      return;
   }

   SendLocalResult(id, 10036, "ticket not found as position or pending order");
}

void HandleCommandLine(const string line)
{
   string type = "";
   if(!JsonGetString(line, "type", type))
      return;
   if(type == "order")
      HandleOrderCommand(line);
   else if(type == "cancel")
      HandleCancelCommand(line);
   else if(type == "close")
      HandleCloseCommand(line);
   else if(type == "modify")
      HandleModifyCommand(line);
   else if(type == "ping")
   {
      string id = "";
      if(JsonGetString(line, "id", id))
         SendResult(id, true, 10009, 0, 0, 0.0, 0.0, "");
   }
}

void ProcessIncoming()
{
   if(!g_connected)
      return;
   for(int reads = 0; reads < 16; reads++)
   {
      if(!ReadSocketAvailable())
         break;
   }
   int processed = 0;
   string line;
   while(processed < 100 && ExtractLine(line))
   {
      if(line != "")
      {
         HandleCommandLine(line);
         processed++;
      }
   }
}

//+------------------------------------------------------------------+
//| Market events                                                    |
//+------------------------------------------------------------------+
void SendTick()
{
   if(!InpSendTicks || !g_connected)
      return;
   ulong throttle = 1000;
   if(InpMaxTicksPerSecond > 0)
      throttle = (ulong)(1000 / InpMaxTicksPerSecond);
   if(throttle < 1)
      throttle = 1;
   ulong now = GetTickCount64();
   if(now - g_last_tick_ms < throttle)
      return;
   MqlTick tick;
   if(!SymbolInfoTick(InpSymbol, tick))
      return;
   g_last_tick_ms = now;
   string js = "{" +
               JKey("v") + IntegerToString(PROTOCOL_VERSION) + "," +
               JKey("type") + JStr("tick") + "," +
               JKey("symbol") + JStr(InpSymbol) + "," +
               JKey("ts_msc") + JLong((long)tick.time_msc) + "," +
               JKey("bid") + JNum(tick.bid, g_symbol_digits) + "," +
               JKey("ask") + JNum(tick.ask, g_symbol_digits) + "," +
               JKey("last") + JNum(tick.last, g_symbol_digits) + "," +
               JKey("volume") + JNum(tick.volume_real, 2) + "," +
               JKey("flags") + IntegerToString(tick.flags) +
               "}";
   QueueLatestTick(js);
}

void SendTradeTransaction(const MqlTradeTransaction &trans)
{
   if(!g_connected)
      return;
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD)
      return;
   if(trans.symbol != "" && trans.symbol != InpSymbol)
      return;
   string side = "";
   double volume = trans.volume;
   double price = trans.price;
   double profit = 0.0;
   long time_msc = (long)TimeCurrent() * 1000;
   if(HistoryDealSelect(trans.deal))
   {
      long deal_type = HistoryDealGetInteger(trans.deal, DEAL_TYPE);
      if(deal_type == DEAL_TYPE_BUY)
         side = "buy";
      else if(deal_type == DEAL_TYPE_SELL)
         side = "sell";
      double deal_volume = HistoryDealGetDouble(trans.deal, DEAL_VOLUME);
      double deal_price = HistoryDealGetDouble(trans.deal, DEAL_PRICE);
      if(deal_volume > 0.0)
         volume = deal_volume;
      if(deal_price > 0.0)
         price = deal_price;
      profit = HistoryDealGetDouble(trans.deal, DEAL_PROFIT);
      long deal_time = HistoryDealGetInteger(trans.deal, DEAL_TIME_MSC);
      if(deal_time > 0)
         time_msc = deal_time;
   }
   if(side == "")
   {
      if(trans.deal_type == DEAL_TYPE_BUY)
         side = "buy";
      else if(trans.deal_type == DEAL_TYPE_SELL)
         side = "sell";
   }
   string js = "{" +
               JKey("v") + IntegerToString(PROTOCOL_VERSION) + "," +
               JKey("type") + JStr("trade") + "," +
               JKey("trans_type") + IntegerToString((long)trans.type) + "," +
               JKey("order") + IntegerToString((long)trans.order) + "," +
               JKey("deal") + IntegerToString((long)trans.deal) + "," +
               JKey("position") + IntegerToString((long)trans.position) + "," +
               JKey("symbol") + JStr(InpSymbol) + "," +
               JKey("side") + JStr(side) + "," +
               JKey("volume") + JNum(volume, 2) + "," +
               JKey("price") + JNum(price, g_symbol_digits) + "," +
               JKey("profit") + JNum(profit, 2) + "," +
               JKey("time_msc") + JLong(time_msc) +
               "}";
   QueueCritical(js);
   FlushOutgoing(16);
}

//+------------------------------------------------------------------+
//| Timeframe parsing                                                |
//+------------------------------------------------------------------+
bool AddTimeframe(const string raw)
{
   string name = raw;
   StringTrimLeft(name);
   StringTrimRight(name);
   StringToLower(name);
   if(name == "")
      return true;
   ENUM_TIMEFRAMES tf;
   if(name == "1m")
      tf = PERIOD_M1;
   else if(name == "5m")
      tf = PERIOD_M5;
   else if(name == "15m")
      tf = PERIOD_M15;
   else if(name == "1h")
      tf = PERIOD_H1;
   else
   {
      Print("WebBridge: unsupported timeframe (v1 supports 1m,5m,15m,1h): ", name);
      return false;
   }
   int count = ArraySize(g_tfs);
   for(int i = 0; i < count; i++)
      if(g_tfs[i] == tf)
         return true;
   ArrayResize(g_tfs, count + 1);
   ArrayResize(g_tf_names, count + 1);
   g_tfs[count] = tf;
   g_tf_names[count] = name;
   return true;
}

bool ParseTimeframes()
{
   ArrayResize(g_tfs, 0);
   ArrayResize(g_tf_names, 0);
   string parts[];
   ushort comma = StringGetCharacter(",", 0);
   int count = StringSplit(InpBarPeriods, comma, parts);
   if(count <= 0)
   {
      Print("WebBridge: InpBarPeriods is empty");
      return false;
   }
   for(int i = 0; i < count; i++)
   {
      if(!AddTimeframe(parts[i]))
         return false;
   }
   if(ArraySize(g_tfs) == 0)
   {
      Print("WebBridge: no valid timeframes");
      return false;
   }
   ResetBarCaches();
   return true;
}

//+------------------------------------------------------------------+
//| MT5 event handlers                                               |
//+------------------------------------------------------------------+
int OnInit()
{
   if(InpToken == "" || InpToken == "change-me-before-use")
      Print("WebBridge: WARNING change InpToken before production use");
   if(InpHost != "127.0.0.1" && InpHost != "localhost" && InpHost != "::1")
      Print("WebBridge: WARNING gateway is not loopback; secure the network path");
   if(!SymbolSelect(InpSymbol, true))
   {
      Print("WebBridge: symbol not available: ", InpSymbol);
      return INIT_PARAMETERS_INCORRECT;
   }
   if(_Symbol != InpSymbol)
      Print("WebBridge: WARNING chart symbol ", _Symbol, " differs from InpSymbol ", InpSymbol,
            ". Use a dedicated ", InpSymbol, " chart.");
   g_symbol_digits = (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS);
   if(!ParseTimeframes())
      return INIT_PARAMETERS_INCORRECT;
   ArrayResize(g_out_queue, 2048);
   g_out_head = 0;
   g_out_count = 0;
   g_connected = false;
   g_socket = INVALID_SOCKET;
   EventSetTimer(1);
   if(!ConnectToGateway())
      Print("WebBridge: gateway not available yet; will retry on timer");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   MarkDisconnected("EA deinitialized");
}

void OnTick()
{
   if(!g_connected)
      return;
   if(!SocketIsConnected(g_socket))
   {
      MarkDisconnected("socket disconnected");
      return;
   }
   SendTick();
   ProcessIncoming();
   FlushOutgoing(64);
}

void OnTimer()
{
   if(g_connected && !SocketIsConnected(g_socket))
      MarkDisconnected("socket disconnected");
   if(!g_connected)
   {
      ulong now = GetTickCount64();
      if(now - g_last_connect_attempt < (ulong)MathMax(250, InpReconnectMs))
         return;
      g_last_connect_attempt = now;
      if(!ConnectToGateway())
         return;
   }
   // Heartbeat first so a slow synchronous OrderSend later in this tick cannot
   // delay liveness more than necessary.
   SendHeartbeat();
   FlushOutgoing(8);
   ProcessIncoming();
   SendBarsUpdate();
   SendAccountSnapshot();
   SendPositionsSnapshot();
   SendOrdersSnapshot();
   FlushOutgoing(5000);
}

void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   SendTradeTransaction(trans);
}
//+------------------------------------------------------------------+
