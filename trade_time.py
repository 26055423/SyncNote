"""Keep broker wall timestamps separate from verified UTC instants."""
import json, os, math
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# User-approved provisional rule; raw wall times are retained for later correction.
RULES={'EasyTradingOnlineLtd-Server':{'offset_seconds':10800,'provisional':True}}
RULES.update(json.loads(os.environ.get('BROKER_TIME_RULES','{}')))


def offset_for(db, source):
    """时间对齐的唯一入口：券商墙钟 → UTC 要减掉的秒数。

    优先级：
      1. `RULES` 里按券商服务器写的规则（可以带 DST，走 `zoneinfo`）；
      2. `source_clock` 里观测到的偏移（`bind_feed` 从 `broker_clocks` 记的）；
      3. 0（当作 UTC 处理）。

    所有"库里存墙钟、出库换 UTC"的地方都必须走这里，别各自算。
    """
    name = source[4:] if isinstance(source, str) and source.startswith('srv:') else source
    rule = RULES.get(name)
    if rule and isinstance(rule.get('offset_seconds'), int):
        return int(rule['offset_seconds'])
    try:
        row = db.execute('SELECT offset_sec FROM source_clock WHERE source=?', (source,)).fetchone()
        if row is not None and isinstance(row['offset_sec'], int):
            return int(row['offset_sec'])
    except Exception:
        pass
    return 0

def utc_trade(trade, clock=None):
    result=dict(trade)
    clock=dict(clock) if clock else None
    # History imports carry their own broker identity. A person's old WebBridge
    # clock must not override another broker or erase an already stored UTC date.
    history_broker=result.get('server') if result.get('source')=='syncnote-history.v1' else None
    if history_broker and clock and clock.get('broker')!=history_broker:clock=None
    if result.get('time_basis')=='utc' and not result.get('time_estimated'):return result
    raw=result.get('closed_server',result.get('closed'))
    result['closed_server']=raw
    result['closed']=None
    result['time_verified']=False
    result['time_estimated']=False
    if raw is None:return result
    rule=RULES.get(history_broker or (clock['broker'] if clock else None))
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
    elif history_broker and isinstance(result.get('history_offset_seconds'),int) and not isinstance(result['history_offset_seconds'],bool) and -43200<=result['history_offset_seconds']<=50400:
        instant=raw-result['history_offset_seconds'];estimated=True
    elif clock and clock.get('offset') is not None:
        instant=raw-clock['offset']
        if not clock['observed_from']-10<=instant<=clock['observed_to']+10:return result
    elif isinstance(result.get('history_offset_seconds'),int) and not isinstance(result['history_offset_seconds'],bool) and -43200<=result['history_offset_seconds']<=50400:
        instant=raw-result['history_offset_seconds'];estimated=True
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

def record_ea_clock_sample(db,person,broker,sample,now):
 """Validate an actual EA UTC/offset sample before mapping requested ranges."""
 if not isinstance(sample,dict):raise ValueError('请等待 EA 返回券商时钟后重新同步')
 ms,offset=sample.get('server_time_ms'),sample.get('server_offset_sec')
 if any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) for x in (ms,offset)):
  raise ValueError('EA 券商时钟格式不正确')
 if abs(ms/1000-now)>120 or not -43200<=offset<=50400 or offset%900:
  raise ValueError('EA 券商时钟尚未校准，请等待最新账户快照后重试')
 return record_clock(db,person,broker,{'clock':{'utc':ms/1000,'server':ms/1000+offset}},now)
