"""Keep broker wall timestamps separate from verified UTC instants."""
import json, os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# User-approved provisional rule; raw wall times are retained for later correction.
RULES={'EasyTradingOnlineLtd-Server':{'offset_seconds':10800,'provisional':True}}
RULES.update(json.loads(os.environ.get('BROKER_TIME_RULES','{}')))

def utc_trade(trade, clock=None):
    result=dict(trade)
    clock=dict(clock) if clock else None
    if result.get('time_basis')=='utc' and not result.get('time_estimated'):return result
    raw=result.get('closed_server',result.get('closed'))
    result['closed_server']=raw
    result['closed']=None
    result['time_verified']=False
    result['time_estimated']=False
    if raw is None:return result
    rule=RULES.get(clock['broker']) if clock else None
    observed=bool(clock and clock.get('offset') is not None and clock['observed_from']-10<=raw-clock['offset']<=clock['observed_to']+10)
    estimated=False
    if observed:
        instant=raw-clock['offset']
    elif rule:
        estimated=bool(rule.get('provisional'))
        wall=datetime.fromtimestamp(raw-rule.get('shift_seconds',0),timezone.utc).replace(tzinfo=None)
        if 'zone' in rule:
            zone=ZoneInfo(rule['zone']);a=wall.replace(tzinfo=zone,fold=0);b=wall.replace(tzinfo=zone,fold=1)
            # A repeated/nonexistent wall time needs an independent UTC anchor.
            if a.utcoffset()!=b.utcoffset():return result
            instant=a.timestamp()
            if datetime.fromtimestamp(instant,zone).replace(tzinfo=None)!=wall:return result
        else:instant=raw-rule['offset_seconds']
    elif clock and clock.get('offset') is not None:
        instant=raw-clock['offset']
        if not clock['observed_from']-10<=instant<=clock['observed_to']+10:return result
    else:return result
    result.update(closed=instant,time_verified=not estimated,time_estimated=estimated,time_basis='utc')
    return result

def record_clock(db,person,broker,snapshot,now):
    old=db.execute('SELECT * FROM broker_clocks WHERE person=?',(person,)).fetchone()
    offset=old['offset'] if old else None
    start=old['observed_from'] if old else now
    end=old['observed_to'] if old else now
    value=snapshot.get('clock')
    if isinstance(value,dict):
        server,utc=value.get('server'),value.get('utc')
        if all(isinstance(x,(int,float)) and not isinstance(x,bool) for x in (server,utc)) and abs(utc-now)<=120:
            measured=round((server-utc)/900)*900
            if -43200<=measured<=50400 and abs(server-utc-measured)<=30:
                if offset!=measured:start=now
                offset=measured;end=now
    db.execute('INSERT INTO broker_clocks VALUES(?,?,?,?,?) ON CONFLICT(person) DO UPDATE SET broker=excluded.broker,offset=excluded.offset,observed_from=excluded.observed_from,observed_to=excluded.observed_to',(person,broker,offset,start,end))
    return db.execute('SELECT * FROM broker_clocks WHERE person=?',(person,)).fetchone()
