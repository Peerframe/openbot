"""Bounded Owner audit queries and spreadsheet-safe RFC 4180 exports."""
import csv
from datetime import datetime
import io
import json

from .control_errors import ControlError
from .models import iso_timestamp

AUDIT_CATEGORIES=("authentication","settings","hosts","approvals","channels","bots","runs","plugins","other")
AUDIT_PAYLOAD_KEYS=("name","from","to","actor","reason","emoji","active","decision",
    "removedBotId","deletedMessages","redactedMessages","directBotId","revokedSessions","nodeId","revision",
    "operationId","attachmentId","fileName","sizeBytes","freedBytes","removed","retainedCount","trashAutoPurgeDays","outcome")
_CATEGORY_SQL=r"""CASE
 WHEN e.type LIKE 'AUTH\_%' ESCAPE '\' OR e.type LIKE 'OWNER\_%' ESCAPE '\' THEN 'authentication'
 WHEN e.type LIKE 'MODEL\_%' ESCAPE '\' OR e.type LIKE 'SETTINGS\_%' ESCAPE '\' OR e.type='EMPLOYEE_MODEL_UPDATED' THEN 'settings'
 WHEN e.type LIKE 'WORKER_HOST\_%' ESCAPE '\' OR e.type LIKE 'NODE\_%' ESCAPE '\' THEN 'hosts'
 WHEN e.type LIKE '%APPROVAL%' OR e.type LIKE 'ACTION\_%' ESCAPE '\' THEN 'approvals'
 WHEN e.type LIKE 'CHANNEL\_%' ESCAPE '\' OR e.type LIKE 'MESSAGE\_%' ESCAPE '\' OR e.type LIKE '%CHANNEL' THEN 'channels'
 WHEN e.type LIKE 'BOT\_%' ESCAPE '\' OR e.type LIKE 'EMPLOYEE\_%' ESCAPE '\' THEN 'bots'
 WHEN e.type LIKE 'RUN\_%' ESCAPE '\' OR e.type LIKE 'WORK\_%' ESCAPE '\' OR e.type LIKE 'TASK\_%' ESCAPE '\' THEN 'runs'
 WHEN e.type LIKE 'PLUGIN\_%' ESCAPE '\' THEN 'plugins'
 ELSE 'other' END""".replace("%","%%")
# Do not transfer whole event payloads (which can contain prompts/keys) to the driver.
_PAYLOAD_SQL="jsonb_strip_nulls(jsonb_build_object("+",".join(
    f"'{key}',CASE WHEN jsonb_typeof(e.payload->'{key}')='string' THEN to_jsonb(left(e.payload->>'{key}',{160 if key == 'fileName' else 120})) "
    f"WHEN jsonb_typeof(e.payload->'{key}') IN ('number','boolean') AND octet_length((e.payload->'{key}')::text)<=40 "
    f"THEN e.payload->'{key}' ELSE NULL END" for key in AUDIT_PAYLOAD_KEYS)+"))"


def parse_query(query, *, export=False):
    if set(query)-{"before","limit","category"} or any(len(query.getlist(key))!=1 for key in query):
        raise ControlError(422,"invalid_audit_query")
    limit=query.get("limit","1000" if export else "50")
    if not limit.isascii() or not limit.isdigit() or len(limit)>4:
        raise ControlError(422,"invalid_audit_limit")
    return dict(before=query.get("before"),category=query.get("category"),limit=int(limit))


async def audit_records(transactions,token,*,before=None,limit=50,category=None,maximum=100):
    if type(limit) is not int or not 1<=limit<=maximum:
        raise ControlError(422,"invalid_audit_limit")
    if category is not None and category not in AUDIT_CATEGORIES:
        raise ControlError(422,"invalid_audit_category")
    cursor=cursor_id=None
    if before is not None:
        try:
            if not isinstance(before,str) or len(before)>200:raise ValueError()
            instant,cursor_id=before.split("|",1);cursor=datetime.fromisoformat(instant)
            if cursor.tzinfo is None or not 1<=len(cursor_id)<=128:raise ValueError()
        except (AttributeError,ValueError):
            raise ControlError(422,"invalid_audit_cursor") from None
    async with transactions.transaction(token) as db:
        rows=await (await db.execute(
            "SELECT left(e.id,129) AS id,left(e.type,65) AS type,e.created_at,"
            "left(e.channel_id,129) AS channel_id,left(e.bot_id,129) AS bot_id,left(e.run_id,129) AS run_id,"+
            _PAYLOAD_SQL+" AS payload,"+_CATEGORY_SQL+" AS category,"
            "left(c.name,81) AS channel_name,c.deleted_at IS NOT NULL AS channel_deleted,"
            "left(b.name,65) AS bot_name,b.deleted_at IS NOT NULL AS bot_deleted "
            "FROM run_events e LEFT JOIN channels c ON c.id=e.channel_id LEFT JOIN bots b ON b.id=e.bot_id "
            "WHERE (%s::timestamptz IS NULL OR (e.created_at,e.id)<(%s::timestamptz,%s::text)) "
            "AND (%s::text IS NULL OR ("+_CATEGORY_SQL+")=%s) "
            "ORDER BY e.created_at DESC,e.id DESC LIMIT %s",(cursor,cursor,cursor_id,category,category,limit+1))).fetchall()
        events=[]
        for row in rows[:limit]:
            if any(row[key] is not None and len(row[key])>128 for key in ("id","channel_id","bot_id","run_id")):
                raise ControlError(503,"audit_projection_limit")
            payload=row["payload"] if isinstance(row["payload"],dict) else {}
            details={key:payload[key] for key in AUDIT_PAYLOAD_KEYS
                if isinstance(payload.get(key),(str,int,bool)) and not isinstance(payload.get(key),float)
                and (not isinstance(payload[key],int) or abs(payload[key])<=9007199254740991)}
            event=dict(id=row["id"],type=row["type"][:64],category=row["category"],
                       createdAt=iso_timestamp(row["created_at"]),details=details)
            for key,column in (("channelId","channel_id"),("botId","bot_id"),("runId","run_id")):
                if row[column] is not None:event[key]=row[column]
            for prefix in ("channel","bot"):
                if row[prefix+"_name"] is not None:
                    event[prefix+"Name"]=row[prefix+"_name"]
                    event[prefix+"Deleted"]=bool(row[prefix+"_deleted"])
            events.append(event)
        last=rows[limit-1] if len(rows)>limit else None
        return dict(events=events,**({"nextBefore":last["created_at"].isoformat()+"|"+last["id"]} if last else {}))


def csv_cell(value):
    text=str(value) if value is not None else ""
    if text[:1] in ("=","+","-","@","\t","\r","\n","＝","＋","－","＠") or text.lstrip(" \t\r\n\x00\ufeff")[:1] in ("=","+","-","@","＝","＋","－","＠"):
        return "'"+text
    return text


def export_csv(events):
    columns=("id","createdAt","category","type","channelId","channelName","botId","botName","runId","details")
    stream=io.StringIO(newline="");stream.write("\ufeff")
    writer=csv.writer(stream,quoting=csv.QUOTE_ALL,lineterminator="\r\n")
    writer.writerow(columns)
    for event in events:
        writer.writerow([csv_cell(json.dumps(event.get(key,{}),ensure_ascii=False,separators=(",",":"))
            if key=="details" else event.get(key,"")) for key in columns])
    data=stream.getvalue().encode("utf-8")
    if len(data)>4*1024*1024:raise ControlError(503,"audit_export_limit")
    return data
