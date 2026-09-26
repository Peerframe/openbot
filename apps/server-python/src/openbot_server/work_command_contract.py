"""Strict offline-command values. Parsing and fingerprints never grant execution authority."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
import rfc8785

from .work_values import canonical

MAX_OPERATION_BYTES = 16384
MAX_TOKEN_BYTES = 8192
MAX_METADATA_BYTES = 32768
FINGERPRINT_PREFIX = b"openbot:work-command:operation:v1\0"
SAFE_INTEGER = 2**53 - 1


class CommandContractError(ValueError):
    """Finite public error; never include command, token, key or library exception text."""


def _invalid():
    raise CommandContractError("invalid_command_contract")


def bounded_value(value, *, maximum=MAX_OPERATION_BYTES):
    if maximum not in (512, MAX_TOKEN_BYTES, MAX_OPERATION_BYTES, MAX_METADATA_BYTES):
        _invalid()
    remaining = 4096

    def visit(item, depth):
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 12:
            _invalid()
        if item is None or type(item) is bool:
            return
        if type(item) is int:
            if abs(item) > SAFE_INTEGER:
                _invalid()
        elif type(item) is str:
            if "\0" in item:
                _invalid()
            item.encode("utf-8", errors="strict")
        elif type(item) is list:
            for child in item:
                visit(child, depth + 1)
        elif type(item) is dict:
            for key, child in item.items():
                if type(key) is not str or not key or len(key.encode("utf-8")) > 128 or "\0" in key:
                    _invalid()
                visit(child, depth + 1)
        else:
            _invalid()

    try:
        visit(value, 0)
        encoded = rfc8785.dumps(value)
        if len(encoded) > maximum:
            _invalid()
        return encoded
    except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
        raise CommandContractError("invalid_command_contract") from None


def strict_json(data, *, maximum=MAX_OPERATION_BYTES):
    """Decode bounded JSON before schema or crypto; duplicates are never last-wins."""
    if type(data) is not bytes or not data or len(data) > maximum:
        _invalid()

    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                _invalid()
            result[key] = value
        return result

    def constant(_):
        _invalid()

    try:
        value = json.loads(data.decode("utf-8", errors="strict"),
                           object_pairs_hook=pairs, parse_constant=constant)
        bounded_value(value, maximum=maximum)
        return value
    except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
        raise CommandContractError("invalid_command_contract") from None


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True,
                              revalidate_instances="always", hide_input_in_errors=True)


Digest = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Identity = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")]
ActionIdentity = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")]
Uuid = Annotated[str, Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")]
Filename = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")]
Positive = Annotated[int, Field(ge=1, le=SAFE_INTEGER)]
Millis = Annotated[int, Field(ge=1, le=4102444800000)]
Seconds = Annotated[int, Field(ge=1, le=4102444800)]
Epoch = Annotated[int, Field(ge=1, le=10000)]
Nonce = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$")]


class InputFile(Strict):
    path: Filename
    size: Annotated[int, Field(ge=0, le=20 * 1024 * 1024)]
    sha256: Digest


class OutputFile(Strict):
    name: Filename
    mediaType: Literal["text/plain", "text/csv"]
    maxBytes: Annotated[int, Field(ge=1, le=1024 * 1024)]


class CommandLimits(Strict):
    # Match the accepted precursor ceilings; a wider policy requires a separate qualification.
    nanoCPUs: Annotated[int, Field(ge=1, le=1_000_000_000)]
    memoryMiB: Annotated[int, Field(ge=1, le=512)]
    pids: Annotated[int, Field(ge=1, le=512)]
    nofile: Annotated[int, Field(ge=1, le=256)]
    tmpMiB: Annotated[int, Field(ge=1, le=32)]
    wallSeconds: Annotated[int, Field(ge=1, le=60)]
    outputMiB: Annotated[int, Field(ge=1, le=64)]
    capturedOutputKiB: Annotated[int, Field(ge=1, le=1024)]


class Command(Strict):
    image: Annotated[str, Field(min_length=73, max_length=256,
        pattern=r"^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$")]
    argv: Annotated[list[Annotated[str, Field(min_length=1, max_length=4096)]],
                    Field(min_length=1, max_length=64)]
    inputManifest: Annotated[list[InputFile], Field(max_length=8)]
    inputDigest: Annotated[str, Field(pattern=r"^sha256:[0-9a-f]{64}$")]
    output: OutputFile
    limits: CommandLimits
    network: Literal["none"]
    rootfs: Literal["readonly"]
    user: Literal["10001:10001"]
    environment: Annotated[list[str], Field(max_length=0)]

    @model_validator(mode="after")
    def input_snapshot(self):
        names = [entry.path for entry in self.inputManifest]
        if names != sorted(set(names)) or sum(entry.size for entry in self.inputManifest) > 20 * 1024 * 1024:
            _invalid()
        # Flat ASCII names make this identical to the precursor's existing manifest encoding.
        data = [entry.model_dump() for entry in self.inputManifest]
        if self.inputDigest != "sha256:" + hashlib.sha256(rfc8785.dumps(data)).hexdigest():
            _invalid()
        return self


class CommandIntent(Strict):
    kind: Literal["work_command"]
    version: Literal[1]
    profileDigest: Digest
    command: Command


class CommandRoute(Strict):
    nodeId: Identity
    providerId: Identity
    enforcementKeyId: Identity
    ledgerId: Uuid


class DispatchOperation(Strict):
    format: Literal["openbot.work-command.operation/v1"]
    taskId: Identity
    runId: Identity
    actionId: ActionIdentity
    authorityGeneration: Positive
    originalEpoch: Epoch
    profileDigest: Digest
    route: CommandRoute
    intentDigest: Digest
    command: Command


def parse(model, value):
    try:
        bounded_value(value)
        result = model.model_validate(value)
        # Literal[1] otherwise accepts Python True; reject any coercion, including bool/int.
        if bounded_value(result.model_dump()) != bounded_value(value):
            _invalid()
        return result
    except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
        raise CommandContractError("invalid_command_contract") from None


def derive_operation(intent, *, task_id, run_id, action_id, generation, original_epoch, route):
    checked = parse(CommandIntent, intent)
    _, digest = canonical(checked.model_dump())
    return parse(DispatchOperation, {
        "format": "openbot.work-command.operation/v1", "taskId": task_id, "runId": run_id,
        "actionId": action_id, "authorityGeneration": generation, "originalEpoch": original_epoch,
        "profileDigest": checked.profileDigest, "route": deepcopy(route), "intentDigest": digest,
        "command": checked.command.model_dump()})


def operation_fingerprint(value):
    operation = parse(DispatchOperation, value)
    return hashlib.sha256(FINGERPRINT_PREFIX + bounded_value(operation.model_dump())).hexdigest()


def check_intent(operation, intent):
    operation, intent = parse(DispatchOperation, operation), parse(CommandIntent, intent)
    _, digest = canonical(intent.model_dump())
    if (operation.intentDigest != digest or operation.profileDigest != intent.profileDigest
            or operation.command != intent.command):
        _invalid()
    return operation


class DeadlineAnchors(Strict):
    admittedAtMs: Millis
    rootDeadlineMs: Millis
    nativeDeadlineMs: Millis
    wallSeconds: Annotated[int, Field(ge=1, le=60)]
    hardDeadlineMs: Millis

    @model_validator(mode="after")
    def original_minimum(self):
        expected = min(self.rootDeadlineMs, self.nativeDeadlineMs,
                       self.admittedAtMs + self.wallSeconds * 1000)
        if self.hardDeadlineMs != expected or expected <= self.admittedAtMs:
            _invalid()
        return self


def freeze_deadline(*, admitted_at_ms, root_deadline_ms, native_deadline_ms, wall_seconds):
    if any(type(x) is not int for x in (admitted_at_ms, root_deadline_ms, native_deadline_ms, wall_seconds)):
        _invalid()
    return parse(DeadlineAnchors, {
        "admittedAtMs": admitted_at_ms, "rootDeadlineMs": root_deadline_ms,
        "nativeDeadlineMs": native_deadline_ms, "wallSeconds": wall_seconds,
        "hardDeadlineMs": min(root_deadline_ms, native_deadline_ms, admitted_at_ms + wall_seconds * 1000)})


class CommandBinding(Strict):
    taskId: Identity
    runId: Identity
    actionId: ActionIdentity
    dispatchId: Uuid
    connectionId: Uuid
    originalEpoch: Epoch
    authorityGeneration: Positive
    profileDigest: Digest
    intentDigest: Digest
    operationFingerprint: Digest
    nodeId: Identity
    providerId: Identity
    enforcementKeyId: Identity
    ledgerId: Uuid
    hardDeadlineMs: Millis


class Claims(CommandBinding):
    iss: Identity
    aud: Identity
    jti: Uuid
    iat: Seconds
    nbf: Seconds
    exp: Seconds

    @model_validator(mode="after")
    def time_bounds(self):
        if self.nbf != self.iat or not self.iat < self.exp <= self.iat + 30:
            _invalid()
        return self


class DispatchClaims(Claims):
    purpose: Literal["work_command_dispatch"]
    anchors: DeadlineAnchors

    @model_validator(mode="after")
    def dispatch_bounds(self):
        if (self.hardDeadlineMs != self.anchors.hardDeadlineMs
                or self.iat != self.anchors.admittedAtMs // 1000
                or self.exp * 1000 > self.hardDeadlineMs):
            _invalid()
        return self


class ConsumeClaims(Claims):
    purpose: Literal["work_command_consume"]
    requestId: Uuid
    nonce: Nonce
    ticketDigest: Digest


class PermitClaims(Claims):
    purpose: Literal["work_command_permit"]
    requestId: Uuid
    nonce: Nonce
    requestDigest: Digest
    consumedAtMs: Millis
    launchDeadlineMs: Millis

    @model_validator(mode="after")
    def permit_bounds(self):
        if (self.launchDeadlineMs != min(self.consumedAtMs + 5000, self.hardDeadlineMs)
                or not self.consumedAtMs < self.launchDeadlineMs
                or self.iat != self.consumedAtMs // 1000
                or self.exp * 1000 > self.launchDeadlineMs):
            _invalid()
        return self


class OutputObservation(Strict):
    name: Filename
    mediaType: Literal["text/plain", "text/csv"]
    sizeBytes: Annotated[int, Field(ge=0, le=1024 * 1024)]
    sha256: Digest


class Observation(Strict):
    phase: Literal["prepared", "running", "exited", "unknown"]
    containerId: Digest | None
    startAttempts: Annotated[int, Field(ge=0, le=1)]
    exitCode: Annotated[int, Field(ge=0, le=255)] | None
    sequence: Positive
    runtimeShapeDigest: Digest | None
    outputs: Annotated[list[OutputObservation], Field(max_length=1)]
    truncated: bool

    @model_validator(mode="after")
    def coherent(self):
        if self.phase == "exited":
            if (self.containerId is None or self.runtimeShapeDigest is None
                    or self.exitCode is None or self.startAttempts != 1):
                _invalid()
        elif self.exitCode is not None or self.outputs:
            _invalid()
        if self.phase == "prepared" and (
                self.startAttempts != 0 or self.containerId is not None or self.runtimeShapeDigest is not None):
            _invalid()
        if self.phase == "running" and (
                self.startAttempts != 1 or self.containerId is None or self.runtimeShapeDigest is None):
            _invalid()
        return self


class ReceiptClaims(Claims):
    purpose: Literal["work_command_receipt"]
    requestId: Uuid
    nonce: Nonce
    permitDigest: Digest | None
    observation: Observation

    @model_validator(mode="after")
    def receipt_bounds(self):
        if self.observation.startAttempts and self.permitDigest is None:
            _invalid()
        return self


CLAIM_MODELS = {
    "work_command_dispatch": DispatchClaims, "work_command_consume": ConsumeClaims,
    "work_command_permit": PermitClaims, "work_command_receipt": ReceiptClaims}
PURPOSE_ROLE = {
    "work_command_dispatch": "control", "work_command_consume": "enforcement",
    "work_command_permit": "control", "work_command_receipt": "enforcement"}
TOKEN_TYPES = {purpose: purpose.replace("_", "-") + "+jwt" for purpose in CLAIM_MODELS}


def validate_claims(value, *, purpose, now_ms):
    if purpose not in CLAIM_MODELS or type(now_ms) is not int or not 1 <= now_ms <= 4102444800000:
        _invalid()
    claims = parse(CLAIM_MODELS[purpose], value)
    if not claims.nbf * 1000 <= now_ms < claims.exp * 1000 or claims.iat * 1000 > now_ms:
        _invalid()
    # Receipt collection is historical: its challenge is fresh, its original execution deadline is not.
    if purpose != "work_command_receipt" and now_ms >= claims.hardDeadlineMs:
        _invalid()
    if isinstance(claims, DispatchClaims) and now_ms < claims.anchors.admittedAtMs:
        _invalid()
    if isinstance(claims, PermitClaims) and not claims.consumedAtMs <= now_ms < claims.launchDeadlineMs:
        _invalid()
    return claims
