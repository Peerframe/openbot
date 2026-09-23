"""Bound JSON bytes before decoding; errors never echo submitted fields."""
import asyncio
import json

from fastapi import HTTPException, Request
from starlette.requests import ClientDisconnect


def reject_constant(value: str):
    raise ValueError("Non-standard JSON constant.")


async def read_json(request: Request):
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(422, "Request requires JSON.")
    length = request.headers.get("content-length")
    if length is not None and (not length.isascii() or not length.isdigit() or len(length) > 4 or int(length) > 8192):
        raise HTTPException(413, "Request is too large.")
    body = bytearray()
    try:
        async with asyncio.timeout(5):
            async for chunk in request.stream():
                if len(body) + len(chunk) > 8192:
                    raise HTTPException(413, "Request is too large.")
                body.extend(chunk)
        return json.loads(body.decode("utf-8"), parse_constant=reject_constant)
    except TimeoutError:
        raise HTTPException(408, "Request timed out.") from None
    except (ValueError, RecursionError, ClientDisconnect):
        raise HTTPException(422, "Invalid JSON input.") from None
