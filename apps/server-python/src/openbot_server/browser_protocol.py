"""Retained F browser.session@1 contract; syntax never grants browser authority."""
import base64
import calendar
import math
import re
from typing import Annotated, Literal

from pydantic import AfterValidator, AnyUrl, BaseModel, BeforeValidator, ConfigDict, Field, TypeAdapter
from .identity_inputs import ChannelBotId as Id


def integer(value):
    if type(value) not in (int, float) or (type(value) is float and not math.isfinite(value)) or value != int(value):
        raise ValueError("Invalid browser integer.")
    return int(value)


def url(value):
    TypeAdapter(AnyUrl).validate_python(value)
    return value


class Strict(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", allow_inf_nan=False)


def stamp(value):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", value, re.ASCII):
        raise ValueError("Invalid UTC timestamp.")
    year, month, day = int(value[:4]), int(value[5:7]), int(value[8:10])
    if not 1 <= month <= 12 or not 1 <= day <= calendar.monthrange(year, month)[1]:
        raise ValueError("Invalid browser date.")
    if int(value[11:13]) > 23 or int(value[14:16]) > 59 or int(value[17:19]) > 59:
        raise ValueError("Invalid browser time.")
    return value


Timestamp = Annotated[str, AfterValidator(stamp)]


class Observe(Strict):
    kind: Literal["observe"]


class Take(Strict):
    kind: Literal["take"]


class Release(Strict):
    kind: Literal["release"]


class Navigate(Strict):
    kind: Literal["navigate"]
    url: Annotated[str, Field(min_length=1, max_length=2048), AfterValidator(url)]


class Click(Strict):
    kind: Literal["click"]
    x: Annotated[float, Field(ge=0, le=8192)]
    y: Annotated[float, Field(ge=0, le=8192)]


class Type(Strict):
    kind: Literal["type"]
    text: Annotated[str, Field(min_length=1, max_length=4096)]


class Key(Strict):
    kind: Literal["key"]
    key: Literal["Enter", "Tab", "Shift+Tab", "Backspace", "Delete", "Escape", "ArrowUp",
                 "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "ControlOrMeta+A"]


class Scroll(Strict):
    kind: Literal["scroll"]
    deltaY: Annotated[int, BeforeValidator(integer), Field(ge=-2000, le=2000)]


Action = TypeAdapter(Annotated[Observe | Take | Release | Navigate | Click | Type | Key | Scroll,
                               Field(discriminator="kind")])


class BrowserFrame(Strict):
    base64: Annotated[str, Field(min_length=12, max_length=7_000_000,
        pattern=r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")]
    width: Annotated[int, BeforeValidator(integer), Field(ge=1, le=8192)]
    height: Annotated[int, BeforeValidator(integer), Field(ge=1, le=8192)]
    capturedAt: Timestamp
    url: Annotated[str, Field(max_length=2048)]


class BrowserCommand(Strict):
    type: Literal["browser.command"]
    protocolVersion: Literal["0.9.0"]
    nodeId: Annotated[str, Field(min_length=1, max_length=128)]
    requestId: Id
    sessionId: Id
    botId: Id
    expiresAt: Timestamp
    controlExpiresAt: Timestamp = None
    action: Annotated[Observe | Take | Release | Navigate | Click | Type | Key | Scroll,
                      Field(discriminator="kind")]


class BrowserResult(Strict):
    type: Literal["browser.result"]
    protocolVersion: Literal["0.9.0"]
    nodeId: Annotated[str, Field(min_length=1, max_length=128)]
    requestId: Id
    sessionId: Id
    ok: bool
    frame: BrowserFrame = None
    error: Literal["unavailable", "busy", "expired", "control_required", "invalid_response", "action_failed"] = None


def validate_frame(value):
    frame = BrowserFrame.model_validate(value).model_dump()
    data = base64.b64decode(frame["base64"], validate=True)
    if (not 24 <= len(data) <= 5 * 1024 * 1024 or data[:8] != b"\x89PNG\r\n\x1a\n"
            or int.from_bytes(data[16:20], "big") != frame["width"]
            or int.from_bytes(data[20:24], "big") != frame["height"]):
        raise ValueError("Invalid browser frame.")
    return frame
