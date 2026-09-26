"""Owner-controlled encrypted model settings, translated from OpenBot's MIT TS service.

Only explicit Server configuration selects storage or supplies a legacy encryption key. No
environment credentials, dotenv, model SDK, inference request or arbitrary endpoint is consulted.
The POSIX reference uses nofollow directory descriptors, owner-only files and a process lease.
It deliberately does not assert Windows ACL support.
"""
from __future__ import annotations

import asyncio
import base64
from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
import hmac
import json
import os
from pathlib import Path
import re
import stat
from typing import Any, AsyncContextManager
from urllib.parse import quote
from uuid import uuid4

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import httpx2 as httpx

if os.name == "posix":
    import fcntl

from .control_errors import ControlError
from .model_presets import (
    MODEL_ID_PATTERN, ModelDiscoveryInput, ModelSettingsInput, RetainedModelSettings,
    model_provider_base_url, model_provider_preset, parse_model_discovery, parse_model_settings,
)

_AAD = b"openbot.model-settings/v1"
_FILE_LIMIT = 8192
_JOURNAL_LIMIT = 12 * 1024
_METADATA_DEADLINE = 8.0

# The trusted HTTP composition layer supplies this factory. It must recheck Owner authorization
# on entry and hold the revocation/authority lock until exit. For a save, exit must commit/recheck
# the Owner transaction before returning. The service calls it briefly BEFORE each transmission
# and, separately, across final file publication; it never holds this guard over provider I/O.
AuthorityGuard = Callable[[], AsyncContextManager[Any]]


class ModelSettingsError(ControlError):
    def __init__(self, code: str):
        super().__init__({
            "busy": 409, "conflict": 409, "invalid_credentials": 422,
            "model_unavailable": 422, "provider_unavailable": 422, "storage_unavailable": 503,
        }[code], code)


@asynccontextmanager
async def _trusted_internal_guard():
    yield


def _json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _decode_json(value: bytes) -> Any:
    # JSON.parse does not accept NaN or Infinity; keys/body never appear in error strings.
    def invalid_constant(_: str) -> None:
        raise ValueError("Invalid JSON constant.")
    return json.loads(value.decode("utf-8"), parse_constant=invalid_constant)


def _identity(info: os.stat_result) -> tuple[int, int]:
    return info.st_dev, info.st_ino


def _check_file(info: os.stat_result, limit: int) -> None:
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > limit):
        raise ModelSettingsError("storage_unavailable")


def _open_directory(path: Path, *, create: bool = False) -> int:
    if os.name != "posix" or not path.is_absolute() or ".." in path.parts:
        raise ModelSettingsError("storage_unavailable")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    current = os.open("/", flags)
    try:
        # Resolve each component through a pinned descriptor; a parent symlink is not trusted.
        for part in path.parts[1:]:
            try:
                following = os.open(part, flags, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(part, mode=0o700, dir_fd=current)
                except FileExistsError:
                    pass
                following = os.open(part, flags, dir_fd=current)
            os.close(current)
            current = following
        info = os.fstat(current)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise ModelSettingsError("storage_unavailable")
        return current
    except BaseException:
        os.close(current)
        raise


def _read_file(directory: int, name: str, limit: int) -> bytes | None:
    try:
        before = os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return None
    _check_file(before, limit)
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
    try:
        opened = os.fstat(descriptor)
        _check_file(opened, limit)
        if _identity(before) != _identity(opened):
            raise ModelSettingsError("storage_unavailable")
        chunks: list[bytes] = []
        length = 0
        while length <= limit:
            chunk = os.read(descriptor, min(65536, limit + 1 - length))
            if not chunk:
                break
            chunks.append(chunk)
            length += len(chunk)
        after = os.fstat(descriptor)
        named = os.stat(name, dir_fd=directory, follow_symlinks=False)
        _check_file(after, limit)
        _check_file(named, limit)
        if (length > limit or _identity(named) != _identity(opened)
                or (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
                != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
            raise ModelSettingsError("storage_unavailable")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _atomic_write(directory: int, name: str, contents: bytes) -> None:
    temporary = f".{name}.{uuid4().hex}.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=directory)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


class ModelSettingsService:
    """Complete encrypted settings service for one explicitly selected POSIX private directory.

    ``fetcher`` is a trusted httpx2 transport or MockTransport-compatible request handler, solely
    for composition/testing. Production creates an explicit TLS, no-proxy, no-retry transport.
    ``active``/``load_active`` contain credentials and are internal inference boundaries, never
    HTTP response DTOs. Public HTTP callers must supply ``authority`` to discover/save and must
    authenticate summary reads at the routing boundary.

    A final save holds the file lease across authority entry, publication and authority exit.
    Readers share that lease, so publication remains invisible until the authority transaction
    succeeds. A bounded rollback journal restores the previous encrypted file on guard failure
    or process restart. A crash before acknowledgement may lose that save, never grant opt-in.
    Legacy TS writers do not honor this lease: selecting this service requires a single writer.
    """

    def __init__(self, directory: str | Path, fetcher: Any = None):
        self._initialize(Path(directory), "settings.json", fetcher, None)

    @classmethod
    def from_legacy(cls, path: str | Path, key: str, fetcher: Any = None) -> "ModelSettingsService":
        """Use the Desktop's explicit settingsPath/safeStorage key in place, without copying it."""
        selected = Path(path)
        instance = cls.__new__(cls)
        instance._initialize(selected.parent, selected.name, fetcher, key)
        return instance

    def _initialize(self, directory: Path, name: str, fetcher: Any, explicit_key: str | None) -> None:
        self.directory = directory
        self.path = directory / name
        self._name = name
        self._lock_name = f".{name}.lock"
        self._journal_name = f".{name}.pending"
        self._fetcher = fetcher
        self._busy = False
        self._listeners: set[Callable[[], None]] = set()
        self._file_key = explicit_key is None
        try:
            if not name or name in {".", "..", "encryption.key"}:
                raise ValueError("Invalid settings name.")
            descriptor = _open_directory(directory, create=True)
            try:
                self._directory_identity = _identity(os.fstat(descriptor))
            finally:
                os.close(descriptor)
            with self._lease() as root:
                if explicit_key is None:
                    key_bytes = _read_file(root, "encryption.key", 64)
                    if key_bytes is None:
                        # A missing key beside ciphertext or a rollback journal is data loss,
                        # never a bootstrap opportunity. lstat also sees dangling symlinks.
                        for retained in (self._name, self._journal_name):
                            try:
                                os.stat(retained, dir_fd=root, follow_symlinks=False)
                            except FileNotFoundError:
                                continue
                            raise ModelSettingsError("storage_unavailable")
                        key_bytes = os.urandom(32).hex().encode("ascii")
                        _atomic_write(root, "encryption.key", key_bytes)
                    explicit_key = key_bytes.decode("ascii")
                if re.fullmatch(r"[a-f0-9]{64}", explicit_key) is None:
                    raise ModelSettingsError("storage_unavailable")
                self._key = bytes.fromhex(explicit_key)
                self._recover(root)
                self._read(root)
        except ControlError:
            raise
        except Exception:
            raise ModelSettingsError("storage_unavailable") from None

    @contextmanager
    def _lease(self) -> Iterator[int]:
        directory = lock = None
        try:
            directory = _open_directory(self.directory)
            if _identity(os.fstat(directory)) != self._directory_identity:
                raise ModelSettingsError("storage_unavailable")
            try:
                lock = os.open(self._lock_name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                               | os.O_NONBLOCK | os.O_CLOEXEC, 0o600, dir_fd=directory)
                os.fchmod(lock, 0o600)
            except FileExistsError:
                lock = os.open(self._lock_name, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                               dir_fd=directory)
            _check_file(os.fstat(lock), 0)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ModelSettingsError("busy") from None
            named = os.stat(self._lock_name, dir_fd=directory, follow_symlinks=False)
            _check_file(named, 0)
            if _identity(named) != _identity(os.fstat(lock)):
                raise ModelSettingsError("storage_unavailable")
            yield directory
        except ControlError:
            raise
        except OSError:
            raise ModelSettingsError("storage_unavailable") from None
        finally:
            if lock is not None:
                os.close(lock)
            if directory is not None:
                os.close(directory)

    def _check_key(self, root: int) -> None:
        if self._file_key:
            value = _read_file(root, "encryption.key", 64)
            if value is None or not hmac.compare_digest(value, self._key.hex().encode("ascii")):
                raise ModelSettingsError("storage_unavailable")

    def _decrypt(self, contents: bytes) -> dict[str, Any]:
        try:
            envelope = _decode_json(contents)
            if (not isinstance(envelope, dict) or set(envelope) != {"version", "nonce", "tag", "ciphertext"}
                    or type(envelope["version"]) is not int or envelope["version"] != 1):
                raise ValueError("Invalid envelope.")
            for field, maximum in (("nonce", 24), ("tag", 24), ("ciphertext", 4096)):
                if not isinstance(envelope[field], str) or len(envelope[field]) > maximum:
                    raise ValueError("Invalid cipher parameters.")
            nonce, tag, ciphertext = (
                base64.b64decode(envelope[field], validate=True) for field in ("nonce", "tag", "ciphertext")
            )
            if len(nonce) != 12 or len(tag) != 16:
                raise ValueError("Invalid cipher parameters.")
            retained = RetainedModelSettings.model_validate(
                _decode_json(AESGCM(self._key).decrypt(nonce, ciphertext + tag, _AAD))
            )
            return self._retained_dict(retained)
        except Exception:
            raise ModelSettingsError("storage_unavailable") from None

    @staticmethod
    def _retained_dict(value: RetainedModelSettings | ModelSettingsInput) -> dict[str, Any]:
        result = value.model_dump(exclude={"baseUrl"})
        if value.baseUrl is not None:
            result["baseUrl"] = value.baseUrl
        return result

    def _encrypt(self, value: dict[str, Any]) -> bytes:
        nonce = os.urandom(12)
        encrypted = AESGCM(self._key).encrypt(nonce, _json(value), _AAD)
        return _json({
            "version": 1, "nonce": base64.b64encode(nonce).decode("ascii"),
            "tag": base64.b64encode(encrypted[-16:]).decode("ascii"),
            "ciphertext": base64.b64encode(encrypted[:-16]).decode("ascii"),
        })

    def _read(self, root: int) -> dict[str, Any] | None:
        self._check_key(root)
        contents = _read_file(root, self._name, _FILE_LIMIT)
        return self._decrypt(contents) if contents is not None else None

    def _restore(self, root: int, previous: bytes | None) -> None:
        if previous is not None:
            _atomic_write(root, self._name, previous)
        else:
            try:
                os.unlink(self._name, dir_fd=root)
            except FileNotFoundError:
                pass
            os.fsync(root)
        os.unlink(self._journal_name, dir_fd=root)
        os.fsync(root)

    def _recover(self, root: int) -> None:
        try:
            self._check_key(root)
            journal = _read_file(root, self._journal_name, _JOURNAL_LIMIT)
            if journal is None:
                return
            value = _decode_json(journal)
            if (not isinstance(value, dict) or set(value) != {"version", "previous"}
                    or type(value["version"]) is not int or value["version"] != 1):
                raise ValueError("Invalid rollback journal.")
            previous = value["previous"]
            if previous is not None:
                if not isinstance(previous, str):
                    raise ValueError("Invalid rollback journal.")
                previous = base64.b64decode(previous, validate=True)
                if len(previous) > _FILE_LIMIT:
                    raise ValueError("Invalid rollback journal.")
                self._decrypt(previous)
            # Do not replace an unsafe current file, even during recovery.
            _read_file(root, self._name, _FILE_LIMIT)
            self._restore(root, previous)
        except ControlError:
            raise
        except Exception:
            raise ModelSettingsError("storage_unavailable") from None

    def _current(self) -> dict[str, Any] | None:
        with self._lease() as root:
            self._recover(root)
            return self._read(root)

    @staticmethod
    def _summary(current: dict[str, Any] | None) -> dict[str, Any]:
        if current is None:
            return {"status": "unconfigured", "revision": None}
        return {
            "status": "configured", "provider": current["provider"], "model": current["model"],
            "baseUrl": model_provider_base_url(current["provider"], current.get("baseUrl")),
            "verification": "metadata" if model_provider_preset(current["provider"])["discovery"] else "not_checked",
            "revision": current["revision"], "agentEnabled": current["agentEnabled"],
        }

    async def summary(self) -> dict[str, Any]:
        return self._summary(self._current())

    async def active(self) -> dict[str, Any] | None:
        """Internal credential-bearing configuration, only after explicit timestamped opt-in."""
        current = self._current()
        return current if current and current["agentEnabled"] and current["agentEnabledAt"] else None

    async def load_active(self) -> dict[str, Any] | None:
        return await self.active()

    def on_change(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._listeners.add(listener)
        return lambda: self._listeners.discard(listener)

    async def save(self, value: object, *, authority: AuthorityGuard | None = None) -> dict[str, Any]:
        parsed = parse_model_settings(value)
        guard = authority or _trusted_internal_guard
        if self._busy:
            raise ModelSettingsError("busy")
        self._busy = True
        try:
            current = self._current()
            if (current["revision"] if current else None) != parsed.revision:
                raise ModelSettingsError("conflict")
            await self._verify(parsed, guard)
            with self._lease() as root:
                self._recover(root)
                previous: bytes | None = None
                journal_written = False
                try:
                    async with guard():
                        current = self._read(root)
                        if (current["revision"] if current else None) != parsed.revision:
                            raise ModelSettingsError("conflict")
                        previous = _read_file(root, self._name, _FILE_LIMIT)
                        stored = self._retained_dict(parsed)
                        stored["revision"] = str(uuid4())
                        stored["agentEnabledAt"] = (
                            ((current.get("agentEnabledAt") if current and current["agentEnabled"] else None)
                             or datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
                            if parsed.agentEnabled else None
                        )
                        envelope = self._encrypt(stored)
                        _atomic_write(root, self._journal_name, _json({
                            "version": 1,
                            "previous": base64.b64encode(previous).decode("ascii") if previous is not None else None,
                        }))
                        journal_written = True
                        _atomic_write(root, self._name, envelope)
                    # Readers hold the same lease: they cannot observe the new file until the
                    # authorization transaction commits. Failed exit restores before releasing.
                    os.unlink(self._journal_name, dir_fd=root)
                    os.fsync(root)
                    journal_written = False
                except BaseException:
                    if journal_written:
                        try:
                            self._restore(root, previous)
                        except Exception:
                            raise ModelSettingsError("storage_unavailable") from None
                    raise
            for listener in tuple(self._listeners):
                try:
                    listener()
                except Exception:
                    # The durable commit already succeeded; a listener cannot turn it into an
                    # ambiguous save failure or expose its private exception to the Owner.
                    pass
            return self._summary(stored)
        finally:
            self._busy = False

    async def discover(self, value: object, *, authority: AuthorityGuard | None = None) -> list[str]:
        parsed = parse_model_discovery(value)
        return await self._discover(parsed, authority or _trusted_internal_guard)

    async def _discover(self, value: ModelDiscoveryInput, guard: AuthorityGuard) -> list[str]:
        if not model_provider_preset(value.provider)["discovery"]:
            raise ModelSettingsError("model_unavailable")
        query = "?output_modalities=text" if value.provider == "openrouter" else (
            "?type=text&sub_type=chat" if value.provider == "siliconflow" else ""
        )
        base = model_provider_base_url(value.provider, value.baseUrl)
        native = "/v1" if value.provider == "anthropic" else ""
        body = await self._metadata(f"{base}{native}/models{query}", self._headers(value), 2 * 1024 * 1024, guard)
        if not isinstance(body, dict) or not isinstance(body.get("data"), list):
            raise ModelSettingsError("provider_unavailable")
        found: dict[str, None] = {}
        for entry in body["data"]:
            if (not isinstance(entry, dict) or not isinstance(entry.get("id"), str)
                    or len(entry["id"].encode("utf-16-le", errors="surrogatepass")) // 2 > 128):
                raise ModelSettingsError("provider_unavailable")
            model = entry["id"]
            if MODEL_ID_PATTERN.fullmatch(model) and len(found) < 256:
                found[model] = None
        return list(found)

    async def _verify(self, value: ModelSettingsInput, guard: AuthorityGuard) -> None:
        headers = self._headers(value)
        if value.provider == "openrouter":
            body = await self._metadata("https://openrouter.ai/api/v1/key", headers, 32 * 1024, guard)
            data = body.get("data") if isinstance(body, dict) else None
            if (not isinstance(data, dict) or data.get("is_management_key") is not False
                    or ("is_provisioning_key" in data and data["is_provisioning_key"] is not False)):
                raise ModelSettingsError("invalid_credentials")
            path = "/".join(quote(part, safe="") for part in value.model.split("/"))
            body = await self._metadata(f"https://openrouter.ai/api/v1/models/{path}/endpoints", headers, 256 * 1024, guard)
            data = body.get("data") if isinstance(body, dict) else None
            if not isinstance(data, dict) or data.get("id") != value.model:
                raise ModelSettingsError("model_unavailable")
            endpoints = data.get("endpoints")
            if not isinstance(endpoints, list) or not 1 <= len(endpoints) <= 1000:
                raise ModelSettingsError("model_unavailable")
            for endpoint in endpoints:
                if (not isinstance(endpoint, dict) or ("supported_parameters" in endpoint and (
                    not isinstance(endpoint["supported_parameters"], list)
                    or any(not isinstance(item, str) for item in endpoint["supported_parameters"])
                ))):
                    raise ModelSettingsError("model_unavailable")
            if value.agentEnabled and not any("tools" in endpoint.get("supported_parameters", []) for endpoint in endpoints):
                raise ModelSettingsError("model_unavailable")
            return
        if not model_provider_preset(value.provider)["discovery"]:
            return
        if value.provider not in {"openai", "anthropic"}:
            if value.model not in await self._discover(value, guard):
                raise ModelSettingsError("model_unavailable")
            return
        base = model_provider_base_url(value.provider, value.baseUrl)
        native = "/v1" if value.provider == "anthropic" else ""
        body = await self._metadata(f"{base}{native}/models/{quote(value.model, safe='')}", headers, 32 * 1024, guard)
        if not isinstance(body, dict) or body.get("id") != value.model:
            raise ModelSettingsError("model_unavailable")

    @staticmethod
    def _headers(value: ModelDiscoveryInput) -> dict[str, str]:
        if value.provider == "anthropic":
            return {"Accept": "application/json", "x-api-key": value.apiKey, "anthropic-version": "2023-06-01"}
        return {"Accept": "application/json", "Authorization": f"Bearer {value.apiKey}"}

    async def _metadata(self, url: str, headers: dict[str, str], maximum: int, guard: AuthorityGuard) -> Any:
        # Check at every outgoing credential transmission, including both OpenRouter requests.
        async with guard():
            pass
        try:
            transport = self._fetcher
            if transport is None:
                transport = httpx.AsyncHTTPTransport(trust_env=False, retries=0)
            elif callable(transport):
                transport = httpx.MockTransport(transport)
            async with asyncio.timeout(_METADATA_DEADLINE):
                async with httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False,
                                             timeout=_METADATA_DEADLINE) as client:
                    async with client.stream("GET", url, headers={**headers, "Accept-Encoding": "identity"}) as response:
                        if response.status_code in {401, 403}:
                            raise ModelSettingsError("invalid_credentials")
                        if response.status_code == 404:
                            raise ModelSettingsError("model_unavailable")
                        if (not 200 <= response.status_code < 300
                                or "application/json" not in response.headers.get("content-type", "")
                                or response.headers.get("content-encoding", "identity").lower() != "identity"):
                            raise ModelSettingsError("provider_unavailable")
                        length = response.headers.get("content-length")
                        if length is not None and (not length.isdigit() or int(length) > maximum):
                            raise ModelSettingsError("provider_unavailable")
                        chunks: list[bytes] = []
                        size = 0
                        if response.is_stream_consumed:
                            # MockTransport responses may already be materialized. Production
                            # streams aiter_raw, so limits apply before decompression/allocation.
                            if len(response.content) > maximum:
                                raise ModelSettingsError("provider_unavailable")
                            chunks.append(response.content)
                        else:
                            async for chunk in response.aiter_raw():
                                size += len(chunk)
                                if size > maximum:
                                    raise ModelSettingsError("provider_unavailable")
                                chunks.append(chunk)
                        return _decode_json(b"".join(chunks))
        except ModelSettingsError:
            raise
        except Exception:
            raise ModelSettingsError("provider_unavailable") from None
