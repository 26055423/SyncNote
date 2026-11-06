"""Run the actual SyncNote file writer against MT5-compatible file doubles.

The text-mode double deliberately expands lone LF to CRLF, reproducing the
original checkpoint failure. Binary writes must preserve UTF-8 bytes exactly.
"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_ea_history import compiler_environment,cpp_source
ROOT=Path(__file__).resolve().parents[1]

class SyncNoteStorageTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  source=(ROOT/'bridge/SyncNote.mq5').read_text(encoding='utf-8-sig')
  start=source.index('bool SNWriteExact(')
  end=source.index('\nbool SNBindToken(',start)
  writer=cpp_source(source[start:end])
  pairing=(ROOT/'bridge/SyncNotePairing.mqh').read_text(encoding='utf-8-sig')
  start=pairing.index('bool SNPairTokenValid(')
  end=pairing.index('\nstring SNPairButtonName(',start)
  token_storage=cpp_source(pairing[start:end])
  command,environment,msvc=compiler_environment()
  cls.temp=tempfile.TemporaryDirectory(prefix='syncnote-storage-')
  cls.addClassCleanup(cls.temp.cleanup)
  folder=Path(cls.temp.name);path=folder/'storage.cpp';cls.exe=folder/'storage.exe'
  path.write_text(r'''
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>
using string=std::string;
using uchar=unsigned char;
using ushort=unsigned short;
using uint=unsigned int;
const int FILE_WRITE=1,FILE_TXT=2,FILE_ANSI=4,FILE_BIN=8,FILE_READ=16,FILE_REWRITE=32,CP_UTF8=65001,INVALID_HANDLE=-1;
bool fail_open=false,short_write=false,fail_flush=false,wrong_size=false,closed=false,flushed=false;
int mode=0,last_error=0;
string stored;
string current_path,read_buffer,g_sn_origin="https://synthetic.example",g_sn_key="synthetic-account-hash";
size_t read_position=0;
std::map<string,string> files;
int StringLen(const string& value){return static_cast<int>(value.size());}
ushort StringGetCharacter(const string& value,int index){return static_cast<uchar>(value[index]);}
string StringSubstr(const string& value,int start,int count=-1){return value.substr(start,count<0?string::npos:count);}
string SNJHash(const string&){return string(64,'f');}
bool FileIsExist(const string& path){return files.count(path)>0;}
int FileOpen(const string& path,int flags,int=0,int=0){
 mode=flags;current_path=path;closed=flushed=false;
 if(fail_open){last_error=500;return INVALID_HANDLE;}
 if(mode&FILE_READ){
  if(!FileIsExist(path))return INVALID_HANDLE;
  read_buffer=files[path];read_position=0;
 }else stored.clear();
 return 1;
}
string FileReadString(int){
 if(read_position>=read_buffer.size())return "";
 size_t end=read_buffer.find('\n',read_position);
 if(end==string::npos)end=read_buffer.size();
 string value=read_buffer.substr(read_position,end-read_position);
 read_position=end<read_buffer.size()?end+1:end;
 if(!value.empty()&&value.back()=='\r')value.pop_back();
 return value;
}
bool FileIsEnding(int){return read_position>=read_buffer.size();}
bool FileMove(const string& from,int,const string& to,int){
 if(!FileIsExist(from))return false;
 files[to]=files[from];files.erase(from);return true;
}
int StringToCharArray(const string& text,std::vector<uchar>& bytes,int start=0,int count=-1,int codepage=CP_UTF8){
 if(codepage!=CP_UTF8)throw std::runtime_error("UTF-8 conversion required");
 bytes.assign(text.begin(),text.end());bytes.push_back(0);return static_cast<int>(bytes.size());
}
void ResetLastError(){last_error=0;}
int GetLastError(){return last_error;}
uint FileWriteString(int,const string& text){
 string converted;
 for(size_t i=0;i<text.size();i++){
  if((mode&FILE_TXT)&&text[i]=='\n'&&(i==0||text[i-1]!='\r'))converted+='\r';
  converted+=text[i];
 }
 if(short_write&&!converted.empty())converted.pop_back();
 stored+=converted;return static_cast<uint>(converted.size());
}
uint FileWriteArray(int,const std::vector<uchar>& bytes,int start=0,int count=-1){
 if(!(mode&FILE_BIN))throw std::runtime_error("FileWriteArray must use binary mode");
 if(count<0)count=static_cast<int>(bytes.size())-start;
 if(start<0||count<0||start+count>static_cast<int>(bytes.size()))throw std::runtime_error("invalid byte range");
 if(short_write&&count>0)count--;
 for(int i=0;i<count;i++)stored+=static_cast<char>(bytes[start+i]);
 return static_cast<uint>(count);
}
void FileFlush(int){flushed=true;if(fail_flush)last_error=501;}
std::uint64_t FileSize(int){return static_cast<std::uint64_t>(stored.size()+(wrong_size?1:0));}
void FileClose(int){if(mode&FILE_WRITE)files[current_path]=stored;closed=true;}
template<class... Args> void Print(const Args&...){}
void check(bool value,const char* why){if(!value)throw std::runtime_error(why);}
''' +writer+r'''
bool SNPairSaveToken(const string token);
''' +token_storage+r'''
int main(int argc,char** argv){try {
 string name=argc>1?argv[1]:"",text="";
 if(name.rfind("recover_",0)==0||name.rfind("canonical_",0)==0){
  string token(64,'a'),other(64,'b'),path=SNPairTokenPath();
  string body="SYNCNOTE_PAIR_1\r\n"+g_sn_origin+"\r\n"+g_sn_key+"\r\n"+token+"\r\n";
  if(name=="recover_wrong_origin")body="SYNCNOTE_PAIR_1\nhttps://other.example\n"+g_sn_key+"\n"+token+"\n";
  else if(name=="recover_wrong_account")body="SYNCNOTE_PAIR_1\n"+g_sn_origin+"\nother-account\n"+token+"\n";
  else if(name=="recover_bad_magic")body="WRONG_FORMAT\n"+g_sn_origin+"\n"+g_sn_key+"\n"+token+"\n";
  else if(name=="recover_missing_field")body="SYNCNOTE_PAIR_1\n"+g_sn_origin+"\n"+g_sn_key+"\n";
  else if(name=="recover_truncated")body="SYNCNOTE_PAIR_1\n"+g_sn_origin+"\n"+g_sn_key+"\n"+token.substr(0,63);
  else if(name=="recover_extra")body+="extra\r\n";
  else if(name=="recover_short_write")short_write=true;
  else if(name=="canonical_priority")files[path]="SYNCNOTE_PAIR_1\n"+g_sn_origin+"\n"+g_sn_key+"\n"+other+"\n";
  else if(name=="canonical_invalid")files[path]="invalid canonical record\n";
  else if(name!="recover_valid")throw std::runtime_error("unknown recovery test");
  files[path+".next"]=body;
  string loaded=SNPairLoadToken();
  if(name=="recover_valid"){
   check(loaded==token,"complete old CRLF-expanded approval should recover without pairing again");
   check(FileIsExist(path)&&!FileIsExist(path+".next"),"recovery must atomically replace canonical file");
   check(files[path]=="SYNCNOTE_PAIR_1\n"+g_sn_origin+"\n"+g_sn_key+"\n"+token+"\n","recovery must write exact UTF-8 LF bytes without NUL");
  }else if(name=="canonical_priority"){
   check(loaded==other&&files[path+".next"]==body,"canonical authorization must take precedence over old next file");
  }else{
   check(loaded.empty(),"untrusted, incomplete or unpersisted recovery must not grant authorization");
   if(name!="canonical_invalid")check(!FileIsExist(path),"invalid next file must never create canonical authorization");
  }
 }else if(name=="text_mode_reproduces_original_cause"){
  text="SYNTHETIC_STATE\nsite\naccount\nchecksum\n";
  int f=FileOpen("synthetic",FILE_WRITE|FILE_TXT|FILE_ANSI,0,CP_UTF8);
  uint written=FileWriteString(f,text);FileFlush(f);FileClose(f);
  check(written==text.size()+4,"text-mode double must reproduce four extra CR bytes");
  check(stored=="SYNTHETIC_STATE\r\nsite\r\naccount\r\nchecksum\r\n","text mode must expand LF, rather than hiding the original storage bug");
 }else{
  if(name=="lf_multiline")text="SYNTHETIC_STATE\nsite\naccount\nchecksum\n";
  else if(name=="crlf")text="first\r\nsecond\r\n";
  else if(name=="utf8")text=u8"合成状态\n图表符号 €\n只读 ✓\n";
  else if(name=="empty")text="";
  else if(name=="short_write"){text="synthetic\ncheckpoint\n";short_write=true;}
  else if(name=="open_fail"){text="synthetic";fail_open=true;}
  else if(name=="flush_error"){text="synthetic";fail_flush=true;}
  else if(name=="size_mismatch"){text="synthetic";wrong_size=true;}
  else throw std::runtime_error("unknown test");
  bool ok=SNWriteExact("synthetic-only.state",text);
  if(fail_open){check(!ok&&!closed&&!flushed,"open failure must stop without using invalid handle");}
  else if(short_write||fail_flush||wrong_size){
   check(!ok,"short write, flush failure or mismatched file size must never be acknowledged");
   check(closed,"failure paths must close the file handle");
  }else{
   check(ok,"complete binary checkpoint write must succeed");
   check((mode&FILE_BIN)&&!(mode&FILE_TXT),"checkpoint must use binary mode, avoiding newline translation");
   check(stored==text,"stored bytes must match the exact UTF-8 input, including LF and CRLF");
   check(stored.find('\0')==string::npos,"StringToCharArray's trailing NUL must not be persisted");
   check(flushed&&closed,"successful writes must flush and close");
  }
 }
 std::cout<<"ok";return 0;
 }catch(const std::exception& error){std::cerr<<error.what();return 1;}}
''',encoding='utf-8')
  command+=([str(path),'/Fe:'+str(cls.exe),'/Fo:'+str(folder/'storage.obj')] if msvc else [str(path),'-o',str(cls.exe)])
  result=subprocess.run(command,env=environment,cwd=folder,capture_output=True,text=True)
  if result.returncode:raise AssertionError(result.stdout+result.stderr)

 def scenario(self,name):
  result=subprocess.run([str(self.exe),name],capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr)
  self.assertEqual(result.stdout,'ok')
 def test_text_mode_double_reproduces_four_byte_expansion(self):self.scenario('text_mode_reproduces_original_cause')
 def test_lf_multiline_exact_bytes(self):self.scenario('lf_multiline')
 def test_crlf_exact_bytes(self):self.scenario('crlf')
 def test_utf8_exact_bytes_without_nul(self):self.scenario('utf8')
 def test_empty_file_without_nul(self):self.scenario('empty')
 def test_short_write_not_acknowledged(self):self.scenario('short_write')
 def test_open_failure_not_acknowledged(self):self.scenario('open_fail')
 def test_flush_error_not_acknowledged(self):self.scenario('flush_error')
 def test_size_mismatch_not_acknowledged(self):self.scenario('size_mismatch')
 def test_previously_approved_next_recovers_exact_bytes(self):self.scenario('recover_valid')
 def test_next_from_other_origin_rejected(self):self.scenario('recover_wrong_origin')
 def test_next_from_other_account_rejected(self):self.scenario('recover_wrong_account')
 def test_next_bad_magic_rejected(self):self.scenario('recover_bad_magic')
 def test_next_missing_field_rejected(self):self.scenario('recover_missing_field')
 def test_next_truncated_token_rejected(self):self.scenario('recover_truncated')
 def test_next_extra_line_rejected(self):self.scenario('recover_extra')
 def test_next_recovery_short_write_does_not_authorize(self):self.scenario('recover_short_write')
 def test_canonical_takes_precedence(self):self.scenario('canonical_priority')
 def test_invalid_canonical_does_not_fall_back_to_next(self):self.scenario('canonical_invalid')

if __name__=='__main__':unittest.main()
