"""Owner SSE polling loop shared by the workspace and channel reconnect-ready streams.

Callers own authority: each poll re-checks its own session and resource facts inside
observe() and returns None to end the stream. This module only compares the returned
state, encodes ready/heartbeat frames, paces polls and stops on disconnect. It caches no
authorization, starts no task, retries nothing and lets every observe() error propagate.
"""
import asyncio
import json

from fastapi.responses import StreamingResponse

POLL_SECONDS=3
HEARTBEAT='event: heartbeat\ndata: alive\n\n'
STREAM_HEADERS={'Cache-Control':'no-store','X-Accel-Buffering':'no'}


def ready_event(name,payload):
    return 'event: '+name+'\nretry: 2000\ndata: '+json.dumps(payload)+'\n\n'


async def poll_events(request,name,observe,*,sleep=asyncio.sleep):
    """observe() -> (comparison state, ready payload) | None; None ends the stream."""
    previous=None
    while not await request.is_disconnected():
        observed=await observe()
        if observed is None: return
        state,payload=observed
        if state!=previous:
            yield ready_event(name,payload)
            previous=state
        else: yield HEARTBEAT
        await sleep(POLL_SECONDS)


def event_stream(events):
    return StreamingResponse(events,media_type='text/event-stream',headers=dict(STREAM_HEADERS))
