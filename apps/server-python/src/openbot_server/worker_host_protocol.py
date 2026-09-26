"""Strict retained protocol 0.9.0 inputs; no authority is inferred from Host fields."""
import calendar
import math
import re
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, AnyUrl, BeforeValidator, ConfigDict, Field, TypeAdapter, create_model

from .identity_inputs import ChannelBotId, _ECMASCRIPT_WHITESPACE, _bounded_text

PROTOCOL_VERSION = "0.9.0"
MAX_PAYLOAD_BYTES = 32 * 1024 * 1024


def text_type(maximum, minimum=1):
    return _bounded_text(minimum, maximum, description="Trimmed protocol text.")


def integer_type(minimum, maximum):
    def normalize(value):
        if type(value) not in (int, float) or not minimum <= value <= maximum or int(value) != value:
            raise ValueError("Invalid protocol integer.")
        return int(value)
    return Annotated[int, BeforeValidator(normalize), Field(ge=minimum, le=maximum)]


def _node_id(value):
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", value) is None:
        raise ValueError("Invalid Node id.")
    return value


NodeId = Annotated[text_type(128), AfterValidator(_node_id)]
Credential = Annotated[str, Field(min_length=47, max_length=256, pattern=r"^obn_[A-Za-z0-9_-]+$")]
EnrollmentToken = Annotated[str, Field(min_length=48, max_length=256, pattern=r"^obenr_[A-Za-z0-9_-]+$")]


def _timestamp(value):
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", value, re.ASCII) is None:
        raise ValueError("Expected a UTC protocol timestamp.")
    year, month, day = int(value[:4]), int(value[5:7]), int(value[8:10])
    if not 1 <= month <= 12 or not 1 <= day <= calendar.monthrange(year, month)[1]:
        raise ValueError("Invalid protocol date.")
    if int(value[11:13]) > 23 or int(value[14:16]) > 59 or int(value[17:19]) > 59:
        raise ValueError("Invalid protocol time.")
    return value


Timestamp = Annotated[str, AfterValidator(_timestamp)]
Capability = Literal["browser", "shell", "screenshot", "cua", "lume", "coder"]
CapabilityId = Literal["browser.session", "browser.observe", "browser.input", "screen.capture", "desktop.observe",
                       "desktop.input", "shell.execute", "filesystem.read", "filesystem.write",
                       "computer.takeover", "vm.manage", "code.execute"]


def _unique(value):
    if len(value) != len(set(value)):
        raise ValueError("Duplicate capabilities.")
    return value


Capabilities = Annotated[list[Capability], Field(max_length=6), AfterValidator(_unique)]


def _constraints(value):
    if type(value) is not dict:
        raise ValueError("Invalid capability constraints.")
    result = {}
    for key, item in value.items():
        if type(key) is not str or not 1 <= len(key.strip(_ECMASCRIPT_WHITESPACE)) <= 64:
            raise ValueError("Invalid constraint key.")
        if not ((type(item) is str and len(item) <= 256) or type(item) is bool
                or (type(item) in (int, float) and math.isfinite(item))):
            raise ValueError("Invalid constraint value.")
        result[key.strip(_ECMASCRIPT_WHITESPACE)] = item
    if len(result) > 16:
        raise ValueError("Too many constraints.")
    return result


def model(model_name, **fields):
    return create_model(model_name, __config__=ConfigDict(strict=True, extra="forbid"), **fields)


CapabilityDescriptor = model("WorkerCapabilityDescriptor", id=(CapabilityId, ...), version=(integer_type(1, 100), ...),
                             providerId=(text_type(80), ...), constraints=(Annotated[dict, BeforeValidator(_constraints)], Field(default_factory=dict)))
CapabilityRequirement = model("WorkerCapabilityRequirement", id=(CapabilityId, ...), version=(integer_type(1, 100), ...))
EnrollmentInput = model("WorkerEnrollmentInput", nodeId=(NodeId, ...), expiresInSeconds=(integer_type(60, 3600), 600))
ExchangeInput = model("WorkerExchangeInput", nodeId=(NodeId, ...), token=(EnrollmentToken, ...))


def _evidence(value):
    if type(value) is not dict:
        raise ValueError("Invalid approval evidence.")
    result = {}
    for key, item in value.items():
        if type(key) is not str or not 1 <= len(key.strip(_ECMASCRIPT_WHITESPACE)) <= 80:
            raise ValueError("Invalid evidence key.")
        result[key.strip(_ECMASCRIPT_WHITESPACE)] = item
    if len(result) > 32:
        raise ValueError("Too many evidence fields.")
    stack, seen, nodes = [(result, 0)], set(), 0
    while stack:
        item, depth = stack.pop()
        nodes += 1
        if nodes > 256:
            raise ValueError("Too much evidence.")
        if item is None or type(item) is bool:
            continue
        if type(item) in (int, float):
            try:
                if math.isfinite(item):
                    continue
            except OverflowError:
                pass
            raise ValueError("Invalid evidence number.")
        if type(item) is str:
            if len(item.encode("utf-16-le", errors="surrogatepass")) // 2 > 4096:
                raise ValueError("Evidence text exceeds the bound.")
            continue
        if depth >= 6 or id(item) in seen:
            raise ValueError("Evidence is recursive or too deep.")
        seen.add(id(item))
        if type(item) is list and len(item) <= 64:
            stack.extend((child, depth + 1) for child in item)
        elif type(item) is dict and len(item) <= 32:
            for key, child in item.items():
                if type(key) is not str or not 1 <= len(key.encode("utf-16-le", errors="surrogatepass")) // 2 <= 80:
                    raise ValueError("Invalid evidence key.")
                stack.append((child, depth + 1))
        else:
            raise ValueError("Invalid evidence value.")
    return result


def _url(value):
    # Retained z.string().url() is a syntactic URL check, never permission to fetch it.
    value = value.strip(_ECMASCRIPT_WHITESPACE)
    if len(value) > 2048:
        raise ValueError("Artifact URL exceeds the bound.")
    TypeAdapter(AnyUrl).validate_python(value)
    return value


Dimension = integer_type(1, 20000)
Metadata = model("WorkerScreenshotMetadata", width=(Dimension, None), height=(Dimension, None),
                 capturedAt=(Timestamp, None), url=(Annotated[str, AfterValidator(_url), Field(json_schema_extra={"maxLength": 2048})], None))


def base64_type(maximum):
    return Annotated[str, Field(min_length=12, max_length=maximum,
        pattern=r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")]


Artifact = model("WorkerCompletedArtifact", name=(text_type(160), ...), mediaType=(Literal["image/png"], ...),
                 base64=(base64_type(7000000), ...), metadata=(Metadata, None))


def frame(kind, **fields):
    return model("Worker" + kind.replace(".", "_").title(), type=(Literal[kind], ...),
                 protocolVersion=(Literal[PROTOCOL_VERSION], ...), **fields)


NODE_MODELS = {
    "node.hello": frame("node.hello", nodeId=(NodeId, ...), name=(text_type(160), ...),
        platform=(Literal["linux", "windows", "macos", "android", "ios", "freebsd", "unknown"], ...),
        osVersion=(text_type(160), "unknown"), architecture=(Literal["x64", "arm64", "armv7", "riscv64", "unknown"], "unknown"),
        deviceClass=(Literal["server", "desktop", "mobile", "vm", "container", "edge", "unknown"], "unknown"),
        isolation=(Literal["dedicated-host", "user-session", "vm", "container", "managed-device", "unknown"], "unknown"),
        trustTier=(Literal["development", "dedicated", "managed"], "development"), capabilities=(Capabilities, ...),
        capabilityManifest=(Annotated[list[CapabilityDescriptor], Field(max_length=32)], Field(default_factory=list)),
        maxConcurrentRuns=(integer_type(1, 16), ...), credential=(Credential, ...), sentAt=(Timestamp, ...)),
    "node.heartbeat": frame("node.heartbeat", nodeId=(NodeId, ...), activeRunIds=(Annotated[list[ChannelBotId], Field(max_length=16)], ...), sentAt=(Timestamp, ...)),
    "run.accept": frame("run.accept", nodeId=(NodeId, ...), offerId=(ChannelBotId, ...), runId=(ChannelBotId, ...), acceptedAt=(Timestamp, ...)),
    "run.reject": frame("run.reject", nodeId=(NodeId, ...), offerId=(ChannelBotId, ...), runId=(ChannelBotId, ...), reason=(text_type(500), ...), rejectedAt=(Timestamp, ...)),
    "run.start_request": frame("run.start_request", nodeId=(NodeId, ...), runId=(ChannelBotId, ...), requestedAt=(Timestamp, ...)),
    "run.progress": frame("run.progress", nodeId=(NodeId, ...), runId=(ChannelBotId, ...), stage=(text_type(80), ...), message=(text_type(500), ...), occurredAt=(Timestamp, ...)),
    "run.frame": frame("run.frame", nodeId=(NodeId, ...), runId=(ChannelBotId, ...), mediaType=(Literal["image/png"], ...),
        base64=(base64_type(2800000), ...), width=(Dimension, None), height=(Dimension, None), capturedAt=(Timestamp, ...)),
    "approval.request": frame("approval.request", nodeId=(NodeId, ...), runId=(ChannelBotId, ...), requestId=(ChannelBotId, ...),
        action=(text_type(120), ...), target=(text_type(2048), ...), summary=(text_type(500), ...), risk=(Literal["write", "destructive", "privileged"], ...),
        beforeState=(Annotated[dict, BeforeValidator(_evidence)], Field(default_factory=dict)), expiresInSeconds=(integer_type(30, 900), 300), requestedAt=(Timestamp, ...)),
    "run.completed": frame("run.completed", nodeId=(NodeId, ...), runId=(ChannelBotId, ...), summary=(text_type(2000), ...),
        artifacts=(Annotated[list[Artifact], Field(max_length=4)], ...), completedAt=(Timestamp, ...)),
    "run.failed": frame("run.failed", nodeId=(NodeId, ...), runId=(ChannelBotId, ...),
        code=(Literal["provider_unavailable", "provider_execution_failed", "artifact_persistence_failed", "execution_interrupted", "node_disconnected", "approval_policy_denied", "dispatch_failed"], "provider_execution_failed"),
        error=(text_type(2000), ...), failedAt=(Timestamp, ...)),
}

SERVER_MODELS = {
    "run.offer": frame("run.offer", offerId=(ChannelBotId, ...), runId=(ChannelBotId, ...), channelId=(ChannelBotId, ...), botId=(ChannelBotId, ...),
        title=(text_type(80), ...), instruction=(text_type(8000), ...), executionProfile=(Literal["docker-linux", "macos-cua", "lume-vm", "coder"], ...),
        requiredCapabilities=(Annotated[Capabilities, Field(min_length=1)], ...),
        requiredCapabilityManifest=(Annotated[list[CapabilityRequirement], Field(min_length=1, max_length=32)], ...), sentAt=(Timestamp, ...)),
    "run.assigned": frame("run.assigned", runId=(ChannelBotId, ...), nodeId=(NodeId, ...), assignedAt=(Timestamp, ...)),
    "run.start": frame("run.start", runId=(ChannelBotId, ...), nodeId=(NodeId, ...), startedAt=(Timestamp, ...)),
    "run.cancel": frame("run.cancel", runId=(ChannelBotId, ...), reason=(text_type(500), ...), cancelledAt=(Timestamp, ...)),
    "run.settled": frame("run.settled", runId=(ChannelBotId, ...), nodeId=(NodeId, ...), status=(Literal["completed", "failed"], ...), settledAt=(Timestamp, ...)),
    "approval.resolved": frame("approval.resolved", nodeId=(NodeId, ...), runId=(ChannelBotId, ...), requestId=(ChannelBotId, ...),
        decision=(Literal["approved", "rejected", "expired"], ...), decidedAt=(Timestamp, ...)),
    "server.ack": frame("server.ack", accepted=(bool, ...), reason=(text_type(500), None), receivedAt=(Timestamp, ...)),
}


from .browser_protocol import BrowserCommand, BrowserResult
NODE_MODELS["browser.result"] = BrowserResult
SERVER_MODELS["browser.command"] = BrowserCommand


def parse_frame(value: Any, *, server=False) -> dict:
    if type(value) is not dict or type(value.get("type")) is not str:
        raise ValueError("Invalid protocol message.")
    validator = (SERVER_MODELS if server else NODE_MODELS).get(value["type"])
    if validator is None:
        raise ValueError("Invalid protocol type.")
    return validator.model_validate(value).model_dump(exclude_none=True)


# Kept separate so the default retained parser still rejects negotiation fields.
CommandHelloChannel = model("CommandHelloChannel", protocolVersion=(Literal["0.10.0"], ...))
CommandAckChannel = model("CommandAckChannel", protocolVersion=(Literal["0.10.0"], ...),
    connectionId=(Annotated[str, Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")], ...))


def parse_negotiated_frame(value, *, server=False):
    if type(value) is not dict or "commandChannel" not in value:
        return parse_frame(value, server=server)
    expected = "server.ack" if server else "node.hello"
    if value.get("type") != expected or server and value.get("accepted") is not True:
        raise ValueError("Invalid command negotiation.")
    channel = (CommandAckChannel if server else CommandHelloChannel).model_validate(value["commandChannel"]).model_dump()
    base = parse_frame({k:v for k,v in value.items() if k != "commandChannel"}, server=server)
    return {**base, "commandChannel": channel}
