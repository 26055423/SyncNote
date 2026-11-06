// HTTPS-only device pairing. No history/account data is sent before local approval.
#ifndef SYNCNOTE_PAIRING_MQH
#define SYNCNOTE_PAIRING_MQH
string g_sn_pair_secret="",g_sn_pair_code="",g_sn_pair_claim="",g_sn_pair_name="",g_sn_pair_error="";
ulong g_sn_pair_next=0,g_sn_pair_until=0;
int g_sn_pair_decision=0;
bool g_sn_pair_rejected=false;
int g_sn_panel_width=330,g_sn_panel_button_y=190,g_sn_panel_labels=0,g_sn_panel_text_end=1000;
int SNPanelFont(){return MathMax(10,MathMin(24,PanelFontSize));}
string SNPanelName(const string part){return "SyncNote.panel."+IntegerToString(ChartID())+"."+part;}
void SNPanelDelete()
{
 ObjectDelete(0,SNPanelName("background"));
 for(int i=0;i<g_sn_panel_labels;i++)ObjectDelete(0,SNPanelName(IntegerToString(i)));
 g_sn_panel_labels=0;
}
void SNPanelLabel(const string text,const int font,const color ink,int &y,int &count,const string face="Microsoft YaHei")
{
 uint measured_width=0,measured_height=0;
 TextSetFont(face,-font*10);
 TextGetSize(text,measured_width,measured_height);
 int line_height=MathMax((int)MathCeil(font*1.55),(int)measured_height)+5;
 if(y+line_height>g_sn_panel_text_end)return;
 string name=SNPanelName(IntegerToString(count++));
 if(ObjectFind(0,name)<0)ObjectCreate(0,name,OBJ_LABEL,0,0,0);
 ObjectSetInteger(0,name,OBJPROP_CORNER,CORNER_LEFT_UPPER);ObjectSetInteger(0,name,OBJPROP_ANCHOR,ANCHOR_LEFT_UPPER);
 ObjectSetInteger(0,name,OBJPROP_XDISTANCE,22);ObjectSetInteger(0,name,OBJPROP_YDISTANCE,y);
 ObjectSetInteger(0,name,OBJPROP_COLOR,ink);ObjectSetInteger(0,name,OBJPROP_FONTSIZE,font);
 ObjectSetInteger(0,name,OBJPROP_SELECTABLE,false);ObjectSetInteger(0,name,OBJPROP_HIDDEN,true);
 ObjectSetString(0,name,OBJPROP_FONT,face);ObjectSetString(0,name,OBJPROP_TEXT,text);
 ObjectSetString(0,name,OBJPROP_TOOLTIP,text+"\n"+g_sn_origin+"\n"+g_sn_account+" @ "+g_sn_server+"\n"+g_sn_pair_name);
 y+=line_height;
}
void SNPanelText(const string text,const int font,const color ink,int &y,int &count)
{
 string line="";int width=MathMax(1,g_sn_panel_width-28);
 TextSetFont("Microsoft YaHei",-font*10);
 for(int i=0;i<StringLen(text);i++)
 {
  string ch=StringSubstr(text,i,1);uint w=0,h=0;
  bool measured=TextGetSize(line+ch,w,h);
  if(ch=="\n"||(line!=""&&(measured?(int)w>width:StringLen(line)*font>width)))
  {SNPanelLabel(line,font,ink,y,count);line="";if(ch=="\n")continue;}
  line+=ch;
 }
 if(line!="")SNPanelLabel(line,font,ink,y,count);
}
void SNPanelPaint()
{
 int available=(int)ChartGetInteger(0,CHART_WIDTH_IN_PIXELS);
 g_sn_panel_width=MathMax(1,MathMin(660,available-24));
 int chart_height=(int)ChartGetInteger(0,CHART_HEIGHT_IN_PIXELS);
 bool compact=chart_height<380,short_panel=chart_height<280;
 bool waiting_code=g_sn_token==""&&!g_sn_paused&&!g_sn_pair_rejected&&g_sn_pair_error==""&&g_sn_pair_secret!=""&&g_sn_pair_claim==""&&GetTickCount64()<g_sn_pair_until;
 bool buttons=ConnectionCode==""&&SNStillBound()&&(g_sn_token==""||g_sn_paused);
 int button_height=MathMax(36,SNPanelFont()*2+8);
 g_sn_panel_text_end=chart_height-22-(buttons?button_height+8:0);
 string bg=SNPanelName("background");
 if(ObjectFind(0,bg)<0)ObjectCreate(0,bg,OBJ_RECTANGLE_LABEL,0,0,0);
 ObjectSetInteger(0,bg,OBJPROP_CORNER,CORNER_LEFT_UPPER);
 ObjectSetInteger(0,bg,OBJPROP_XDISTANCE,10);ObjectSetInteger(0,bg,OBJPROP_YDISTANCE,10);
 ObjectSetInteger(0,bg,OBJPROP_XSIZE,g_sn_panel_width);
 ObjectSetInteger(0,bg,OBJPROP_BGCOLOR,C'20,28,38');ObjectSetInteger(0,bg,OBJPROP_COLOR,clrSlateGray);
 ObjectSetInteger(0,bg,OBJPROP_BORDER_TYPE,BORDER_FLAT);ObjectSetInteger(0,bg,OBJPROP_SELECTABLE,false);ObjectSetInteger(0,bg,OBJPROP_HIDDEN,true);
 int y=18,count=0,font=SNPanelFont(),small=MathMax(10,font-2);
 SNPanelText(compact?"SyncNote 1.013":"SyncNote 1.013 · 只读同步",font,clrWhite,y,count);
 if(!short_panel||!waiting_code)SNPanelText("MT5 "+g_sn_account+(compact?"":" @ "+g_sn_server),small,clrSilver,y,count);
 if(!compact)SNPanelText(g_sn_origin,small,clrSilver,y,count);
 if(g_sn_paused)
 {
  SNPanelText("同步已暂停",font,clrOrange,y,count);
  SNPanelText(SNStillBound()?"请核对网站授权，或重新配对。":"MT5 账户已变更，请重新挂载 EA。",small,clrWhite,y,count);
 }
 else if(g_sn_token=="")
 {
  if(g_sn_pair_rejected)SNPanelText("已拒绝配对，请重新生成配对码。",font,clrOrange,y,count);
  else if(g_sn_pair_error!="")SNPanelText(g_sn_pair_error,font,clrOrange,y,count);
  else if(g_sn_pair_secret=="")SNPanelText("正在申请配对码…\n请将网站加入 WebRequest 白名单。",font,clrWhite,y,count);
  else if(GetTickCount64()>=g_sn_pair_until)SNPanelText("配对码已过期，请重新生成。",font,clrOrange,y,count);
  else if(g_sn_pair_claim!="")
  {
   SNPanelText("请求配对的同频账号",small,clrSilver,y,count);
   SNPanelText(g_sn_pair_name,font,clrAqua,y,count);
   SNPanelText("核对账号后，允许同步成交与K线。",small,clrWhite,y,count);
  }
  else
  {
   if(chart_height>=220)SNPanelText(compact?"同步配对码":"同步配对码 · 10分钟有效",small,clrSilver,y,count);
   string digits=StringSubstr(g_sn_pair_code,0,4)+" "+StringSubstr(g_sn_pair_code,4);
   int code_font=MathMin(36,font*2);uint w=0,h=0;
   while(code_font>10){TextSetFont("Consolas",-code_font*10);TextGetSize(digits,w,h);if((int)w<=g_sn_panel_width-28&&y+MathMax((int)MathCeil(code_font*1.55),(int)h)+5<=g_sn_panel_text_end)break;code_font--;}
   SNPanelLabel(digits,code_font,clrAqua,y,count,"Consolas");
   SNPanelText("网页填码后回此处授权",small,clrWhite,y,count);
  }
 }
 else
 {
  SNPanelText(g_sn_paused?"同步已暂停，请核对账号或重新配对。":"已授权只读同步",font,g_sn_paused?clrOrange:clrAqua,y,count);
  SNPanelText("已确认 "+IntegerToString(g_sn_ack_batches)+" 批 · 历史 "+IntegerToString(HistoryDays)+" 天",small,clrWhite,y,count);
  if(UploadBars&&!compact)SNPanelText(SNBarsStatus(),small,clrSilver,y,count);
  if(!compact)SNPanelText("无交易权限、无DLL；关闭网页后仍续传。",small,clrSilver,y,count);
 }
 for(int i=count;i<g_sn_panel_labels;i++)ObjectDelete(0,SNPanelName(IntegerToString(i)));
 g_sn_panel_labels=count;g_sn_panel_button_y=MathMin(y+4,MathMax(18,chart_height-button_height-12));
 ObjectSetInteger(0,bg,OBJPROP_YSIZE,MathMax(1,MathMin(chart_height-20,buttons?g_sn_panel_button_y+button_height+8-10:y-2)));
}

bool SNPairTokenValid(const string token)
{
 if(StringLen(token)<16||StringLen(token)>512)return false;
 for(int i=0;i<StringLen(token);i++){ushort c=StringGetCharacter(token,i);if(c<33||c>126)return false;}
 return true;
}
string SNPairTokenPath()
{
 return "SyncNote\\paired-"+StringSubstr(SNJHash(g_sn_origin+"\n"+g_sn_key),0,32)+".txt";
}
string SNPairLoadToken()
{
 int f=FileOpen(SNPairTokenPath(),FILE_READ|FILE_TXT|FILE_ANSI,0,CP_UTF8);
 if(f==INVALID_HANDLE)return "";
 string magic=FileReadString(f),origin=FileReadString(f),account=FileReadString(f),token=FileReadString(f);FileClose(f);
 if(magic!="SYNCNOTE_PAIR_1"||origin!=g_sn_origin||account!=g_sn_key||!SNPairTokenValid(token))return "";
 return token;
}
bool SNPairSaveToken(const string token)
{
 string path=SNPairTokenPath(),temp=path+".next";
 if(!SNWriteExact(temp,"SYNCNOTE_PAIR_1\n"+g_sn_origin+"\n"+g_sn_key+"\n"+token+"\n"))return false;
 return FileMove(temp,0,path,FILE_REWRITE);
}
string SNPairButtonName(const string action){return "SyncNote.pair."+IntegerToString(ChartID())+"."+action;}
void SNPairButton(const string action,const string label,const int x)
{
 string name=SNPairButtonName(action);
 if(ObjectFind(0,name)<0)ObjectCreate(0,name,OBJ_BUTTON,0,0,0);
 ObjectSetInteger(0,name,OBJPROP_CORNER,CORNER_LEFT_UPPER);
 int columns=g_sn_pair_claim!=""&&!g_sn_pair_rejected&&GetTickCount64()<g_sn_pair_until?(g_sn_panel_width>=550?3:2):1;
 int slot=x<100?0:(x<300?1:2),width=MathMax(1,(g_sn_panel_width-24-(columns-1)*8)/columns);
 ObjectSetInteger(0,name,OBJPROP_XDISTANCE,22+slot*(width+8));ObjectSetInteger(0,name,OBJPROP_YDISTANCE,g_sn_panel_button_y);
 ObjectSetInteger(0,name,OBJPROP_XSIZE,width);ObjectSetInteger(0,name,OBJPROP_YSIZE,MathMax(36,SNPanelFont()*2+8));
 ObjectSetInteger(0,name,OBJPROP_FONTSIZE,SNPanelFont());ObjectSetInteger(0,name,OBJPROP_COLOR,clrWhite);
 ObjectSetInteger(0,name,OBJPROP_STATE,false);
 ObjectSetString(0,name,OBJPROP_FONT,"Microsoft YaHei");
 ObjectSetInteger(0,name,OBJPROP_BGCOLOR,clrDarkSlateGray);ObjectSetInteger(0,name,OBJPROP_HIDDEN,true);
 string caption=label;
 if(action=="allow"&&columns==2)caption=g_sn_panel_width<300?"允许":"允许同步";
 if(action=="reset"&&width<SNPanelFont()*12)caption="重新配对";
 ObjectSetString(0,name,OBJPROP_TEXT,caption);
 ObjectSetString(0,name,OBJPROP_TOOLTIP,label);
}
void SNPairDeleteButtons()
{
 ObjectDelete(0,SNPairButtonName("allow"));ObjectDelete(0,SNPairButtonName("deny"));ObjectDelete(0,SNPairButtonName("reset"));
}
void SNPairButtons()
{
 if(ConnectionCode!=""||!SNStillBound()){SNPairDeleteButtons();return;}
 if(g_sn_pair_claim!=""&&g_sn_token==""&&!g_sn_pair_rejected&&GetTickCount64()<g_sn_pair_until)
 {SNPairButton("allow","允许只读同步",10);SNPairButton("deny","拒绝",175);if(g_sn_panel_width>=550)SNPairButton("reset","重新生成配对码",340);else ObjectDelete(0,SNPairButtonName("reset"));}
 else
 {
  ObjectDelete(0,SNPairButtonName("allow"));ObjectDelete(0,SNPairButtonName("deny"));
  if(g_sn_token==""||g_sn_paused)SNPairButton("reset","重新生成配对码",10);
  else ObjectDelete(0,SNPairButtonName("reset"));
 }
}
string SNPairStatus()
{
 if(g_sn_pair_rejected)return "已拒绝本次配对；点击重新生成配对码。";
 if(g_sn_pair_error!="")return g_sn_pair_error;
 if(g_sn_pair_secret=="")return "正在申请只读同步配对码；请将网站加入 WebRequest 白名单。";
 if(GetTickCount64()>=g_sn_pair_until)return "配对码已过期；点击重新生成配对码。";
 if(g_sn_pair_claim!="")return "网站账号："+g_sn_pair_name+"\n核对当前 MT5 账号和网站账号，然后点击下方允许或拒绝。\n允许后上传成交历史及K线，不包含交易权限。";
 return "只读同步配对码："+g_sn_pair_code+"\n在网页 数据连接 → SyncNote只读同步 中输入此码；10分钟有效。\n网页认领后，还需在此图表点击允许。";
}
int SNPairPost(const string endpoint,const string body,string &reply)
{
 reply="";if(!SNStillBound())return -2;
 char data[],response[];int count=StringToCharArray(body,data,0,-1,CP_UTF8)-1;ArrayResize(data,count);
 string headers="";ResetLastError();
 int status=WebRequest("POST",g_sn_origin+"/api/mt5/device/"+endpoint,"Content-Type: application/json\r\n",5000,data,response,headers);
 if(ArraySize(response)>16384)return -3;
 reply=CharArrayToString(response,0,ArraySize(response),CP_UTF8);
 return status;
}
void SNPairReset()
{
 if(!SNStillBound())return;
 if(g_sn_token!="")FileDelete(SNPairTokenPath());
 g_sn_token="";g_sn_pair_secret="";g_sn_pair_code="";g_sn_pair_claim="";g_sn_pair_name="";g_sn_pair_error="";
 g_sn_pair_rejected=false;g_sn_pair_decision=0;g_sn_pair_next=0;g_sn_pair_until=0;g_sn_paused=false;
 g_snh.Reset();g_sn_pending="";g_sn_batch="";g_sn_review_ticket="";g_sn_from=0;g_sn_to=0;
 g_sn_cursor="";g_sn_completed=0;g_sn_last_full=0;g_sn_ack_batches=0;g_sn_retry_after=0;g_sn_next_upload=0;
}
void SNPairPump()
{
 ulong now=GetTickCount64();if(now<g_sn_pair_next||g_sn_pair_rejected)return;
 g_sn_pair_next=now+5000;
 string reply,raw,status;
 if(g_sn_pair_secret=="")
 {
  int http=SNPairPost("start","{}",reply);
  string secret,code,seconds;
  if(http!=200||!SNJTop(reply,"ok",raw)||raw!="true"||!SNJTopString(reply,"device_secret",secret)||!SNJTopString(reply,"code",code)||!SNJTop(reply,"expires_in",seconds))
  {g_sn_pair_error=http==-1?"无法访问网站：请检查网络，并在 MT5 WebRequest 白名单添加 "+g_sn_origin:"申请配对码失败；HTTP "+IntegerToString(http)+"，稍后重试。";return;}
  long ttl;if(!SNPairTokenValid(secret)||StringLen(code)!=8||!SNJSignedPositive(seconds,ttl)||ttl<1||ttl>600)return;
  for(int i=0;i<8;i++){ushort c=StringGetCharacter(code,i);if(c<'0'||c>'9')return;}
  g_sn_pair_secret=secret;g_sn_pair_code=code;g_sn_pair_until=GetTickCount64()+(ulong)ttl*1000;g_sn_pair_error="";SNPaint();return;
 }
 if(now>=g_sn_pair_until){SNPaint();return;}
 if(g_sn_pair_decision!=0&&g_sn_pair_claim!="")
 {
  bool allow=g_sn_pair_decision==1;
  string body="{\"device_secret\":"+SNJQuote(g_sn_pair_secret)+",\"claim_id\":"+SNJQuote(g_sn_pair_claim)+",\"allow\":"+(allow?"true":"false");
  if(allow)body+=",\"account\":"+SNJQuote(g_sn_account)+",\"server\":"+SNJQuote(g_sn_server)+",\"account_key\":"+SNJQuote(g_sn_key);
  body+="}";
  int http=SNPairPost("confirm",body,reply);
  if(!SNStillBound()){SNPause("Account changed during pairing");return;}
  if(http!=200||!SNJTop(reply,"ok",raw)||raw!="true"||!SNJTopString(reply,"status",status))
  {g_sn_pair_error="配对确认失败；HTTP "+IntegerToString(http)+"。账户冲突时请先在网站核对原绑定；不会上传数据。";return;}
  if(!allow&&status=="rejected"){g_sn_pair_rejected=true;g_sn_pair_claim="";g_sn_pair_error="";SNPaint();return;}
  string token;
  if(status!="approved"||!SNJTopString(reply,"token",token)||!SNPairTokenValid(token))return;
  if(!SNPairSaveToken(token)){g_sn_pair_error="授权凭据保存失败；未开始同步，请检查 MT5 文件权限。";return;}
  g_sn_token=token;
  if(!SNPrepareSync()){g_sn_token="";g_sn_pair_error="本机绑定或断点保存失败；未开始同步。";return;}
  g_sn_pair_secret="";g_sn_pair_code="";g_sn_pair_claim="";g_sn_pair_name="";g_sn_pair_error="";g_sn_pair_decision=0;
  SNPaint();return;
 }
 int http=SNPairPost("poll","{\"device_secret\":"+SNJQuote(g_sn_pair_secret)+"}",reply);
 if(http!=200||!SNJTop(reply,"ok",raw)||raw!="true"||!SNJTopString(reply,"status",status))
 {g_sn_pair_error="配对状态暂不可用；HTTP "+IntegerToString(http)+"，请重试或重新生成配对码。";return;}
 if(status=="claimed")
 {
  string claim,name,username;if(!SNJTopString(reply,"claim_id",claim)||!SNJTopString(reply,"nickname",name)||StringLen(claim)<16||StringLen(claim)>128||StringLen(name)>80)return;
  if(SNJTopString(reply,"username",username)&&StringLen(username)<=24)name+=" (@"+username+")";
  StringReplace(name,"\n"," ");StringReplace(name,"\r"," ");
  g_sn_pair_claim=claim;g_sn_pair_name=name;g_sn_pair_error="";SNPaint();
 }
}
void OnChartEvent(const int id,const long &lparam,const double &dparam,const string &sparam)
{
 if(id==CHARTEVENT_CHART_CHANGE){SNPaint();return;}
 if(id!=CHARTEVENT_OBJECT_CLICK||ConnectionCode!=""||!SNStillBound())return;
 if(sparam==SNPairButtonName("reset")){SNPairReset();SNPaint();return;}
 if(g_sn_token!=""||g_sn_pair_claim==""||GetTickCount64()>=g_sn_pair_until)return;
 if(sparam==SNPairButtonName("allow"))g_sn_pair_decision=1;
 else if(sparam==SNPairButtonName("deny"))g_sn_pair_decision=-1;
 else return;
 g_sn_pair_next=0;ObjectSetInteger(0,sparam,OBJPROP_STATE,false);
}
#endif
