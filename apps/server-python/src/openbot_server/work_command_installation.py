"""Explicit local command composition. Loading configuration grants no Work authority."""
from copy import deepcopy
import hashlib
from pathlib import Path
from typing import Annotated, Literal

from cryptography.hazmat.primitives.serialization import (Encoding, PublicFormat,
    load_pem_private_key)
from pydantic import Field

from .model_connections import ModelConnectionsService
from .work_command_contract import Strict, Identity, CommandRoute, Command, CommandLimits, parse, strict_json
from .work_command_crypto import VerificationPin
from .work_command_profiles import CommandProfiles
from .work_command_v2_contract import TimingPolicy
from .work_command_v2_crypto import CommandV2Signer, CommandV2Verifier
from .work_engine_client import read_owned_file
from .work_values import InvalidWork, WorkConflict

_File = Annotated[str, Field(min_length=1, max_length=4096)]


class _Control(Strict):
    issuer: Identity
    keyId: Identity
    privateKeyPath: _File


class _Enforcement(Strict):
    issuer: Identity
    keyId: Identity
    publicKeyPath: _File


class _Policy(Strict):
    id: Identity
    image: Annotated[str, Field(min_length=1, max_length=256)]
    limits: CommandLimits


class _Configuration(Strict):
    version: Literal[1]
    route: CommandRoute
    policy: _Policy
    timing: TimingPolicy
    control: _Control
    enforcement: _Enforcement


def _file(path, *, private, maximum):
    if not isinstance(path, (str, Path)) or not 1 <= len(str(path)) <= 4096:
        raise ValueError()
    path = Path(path)
    # Do not silently follow a deployment alias. The existing reader also uses O_NOFOLLOW
    # at the final open; parent directories remain part of the trusted local installation.
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError()
    return read_owned_file(path, private=private, maximum=maximum)


class CommandInstallation:
    def __init__(self, *, profiles, source_options, timing, signer, verifier, enforcement_issuer):
        # Worker-only imports are fixed in code and reached only by an explicit installation.
        from .work_command_channel import CommandInbox
        self._profiles = profiles
        self._source_options = deepcopy(source_options)
        self._timing, self._signer, self._verifier = timing, signer, verifier
        self._enforcement_issuer = enforcement_issuer
        self._inbox = CommandInbox()
        self._start_claimed = False

    @classmethod
    def from_file(cls, path, connections):
        """None means disabled. A supplied missing/invalid file fails the entire composition."""
        if path is None:
            return None
        try:
            if type(connections) is not ModelConnectionsService:
                raise ValueError()
            value = parse(_Configuration, strict_json(_file(path, private=True, maximum=16384)))
            if (value.route.enforcementKeyId != value.enforcement.keyId
                    or value.control.issuer == value.enforcement.issuer):
                raise ValueError()
            # Use the frozen complete Command parser to validate policy image/limit semantics.
            # This validation-only value is never persisted, dispatched or executed.
            command = parse(Command, dict(image=value.policy.image, limits=value.policy.limits.model_dump(),
                argv=['validation-only'], inputManifest=[], inputDigest='sha256:'+hashlib.sha256(b'[]').hexdigest(),
                output=dict(name='policy.txt',mediaType='text/plain',maxBytes=1), network='none',
                rootfs='readonly',user='10001:10001',environment=[]))
            value.timing.check_budget(1,300001,command.limits.wallSeconds)
            # Match the currently implemented protected Host's native timing envelope.
            if value.timing.runtimeMaxMs > 50000 or value.timing.stopAllowanceMs != 5000:
                raise ValueError()
            private = _file(value.control.privateKeyPath, private=True, maximum=4096)
            signer = CommandV2Signer(issuer=value.control.issuer,kid=value.control.keyId,
                role='control',private_pem=private)
            public = load_pem_private_key(private,password=None).public_key().public_bytes(
                Encoding.PEM,PublicFormat.SubjectPublicKeyInfo)
            # Existing verifier rejects a public key reused across the two signing roles.
            verifier = CommandV2Verifier([
                VerificationPin(value.control.issuer,value.control.keyId,'control',public),
                VerificationPin(value.enforcement.issuer,value.enforcement.keyId,'enforcement',
                    _file(value.enforcement.publicKeyPath,private=False,maximum=4096))])
            profiles = CommandProfiles(connections,policies={value.policy.id:
                dict(image=command.image,limits=command.limits.model_dump())})
            return cls(profiles=profiles,source_options=dict(command_route=value.route.model_dump(),
                command_policy_id=value.policy.id),timing=value.timing,signer=signer,verifier=verifier,
                enforcement_issuer=value.enforcement.issuer)
        except Exception:
            # Paths, parser inputs and PEM/library errors must not reach startup logs.
            raise InvalidWork('command_installation_invalid') from None

    @property
    def profiles(self):
        return self._profiles

    @property
    def source_options(self):
        return deepcopy(self._source_options)

    @property
    def channel_configuration(self):
        return self._inbox.configuration

    def attach(self, transport):
        from .worker_host_commands import WorkerCommandChannel
        if (type(transport) is not WorkerCommandChannel
                or transport.configuration is not self.channel_configuration or self._start_claimed):
            raise WorkConflict('command_installation_transport_changed')
        self._inbox.attach(transport)

    async def driver(self, store, client, scope, files):
        """Initialize the existing service once. Failure/cancellation requires a fresh installation."""
        if (self._inbox.transport is None or self._start_claimed
                or getattr(store,'command_profiles',None) is not self.profiles):
            raise WorkConflict('command_installation_unavailable')
        self._start_claimed = True  # Before any await: concurrent startup cannot replay recovery SQL.
        from .work_command_channel import CommandChannelDriver
        from .work_command_inputs import CommandInputScope
        from .work_command_preparation import ServerPrepareClock
        from .work_command_store import CommandDispatches
        service = CommandDispatches(store,self.profiles,client,scope,self._inbox.transport,
            self._signer,self._verifier,control_issuer=self._signer.issuer,
            enforcement_issuer=self._enforcement_issuer,input_scope=CommandInputScope(files),
            timing_policy=self._timing.model_dump(),
            prepare_clock=ServerPrepareClock(max_step_ms=min(100,self._timing.clockQuantizationMs)))
        await service.start()
        return CommandChannelDriver(service,self._inbox)
