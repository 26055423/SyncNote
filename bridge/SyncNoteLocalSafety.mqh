// Shared pure safety rules, executable unchanged in MQL5 and the C++ regression harness.
#ifndef SYNCNOTE_LOCAL_SAFETY
#define SYNCNOTE_LOCAL_SAFETY
long LocalUnixMsFromFileTime(const ulong ticks)
{
   // Windows FILETIME is unsigned 100ns ticks since 1601-01-01 UTC.
   const ulong epoch=(ulong)116444736000000000;
   if(ticks<epoch) return 0;
   return (long)((ticks-epoch)/(ulong)10000);
}
bool LocalDeadlineValid(const double deadline,const long now_utc)
{
   return now_utc>0 && deadline>(double)now_utc && deadline<=(double)now_utc+30000.0 && deadline==MathFloor(deadline);
}
bool LocalDeadlineReady(const double deadline,const long received_utc,const ulong received_mono,
                        const long now_utc,const ulong now_mono)
{
   if(!LocalDeadlineValid(deadline,received_utc) || !LocalDeadlineValid(deadline,now_utc) || now_mono<received_mono) return false;
   // Clock rollback cannot renew the lifetime originally accepted by the EA.
   return now_mono-received_mono<(ulong)(deadline-(double)received_utc);
}
string LocalSubmissionState(const uint retcode,const ENUM_ORDER_TYPE_FILLING filling)
{
   if(retcode==10010) return filling==ORDER_FILLING_RETURN ? "submitted" : "completed";
   if(retcode==10009 || retcode==10025) return "completed";
   if(retcode==10008) return "submitted";
   if(retcode==0 || retcode==10011 || retcode==10012 || retcode==10031) return "uncertain";
   return "rejected";
}
#endif
