"""Owner-authorized document processing over fixed released parser and SDK adapters.

Retains OpenBot's existing limits/layout. Original bytes and passwords never become parser paths,
and parser children inherit no database or provider credentials. HTTP/lifecycle composition remains
outside this module; explicit ``transcribe`` is the only operation that can send media externally.
"""
import asyncio
from contextlib import suppress
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import signal
import tempfile
from typing import Literal
from urllib.parse import urlsplit

import httpx2
import psycopg
from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, field_validator

from .authority import OwnerTransactions
from .control_errors import ControlError
from .database import StoreUnavailable
from .identity_inputs import _ECMASCRIPT_WHITESPACE
from .models import iso_timestamp
from .owner_files import MAX_BYTES, UUID
from .runtime_child_process import PipeProcess

MAX_TEXT = 262144
MAX_RESPONSE = 2 * 1024 * 1024
PARSER_WORKER = Path(__file__).with_name('parser_worker.mjs')


def _utf16_length(value):
    return len(value.encode('utf-16-le', errors='surrogatepass')) // 2


def _bounded_text(value):
    if type(value) is not str:
        raise ControlError(503, 'invalid_parser_response')
    encoded = value.encode('utf-16-le', errors='surrogatepass')
    # A parser may cut a surrogate pair at the JS limit; discard only that incomplete scalar.
    return encoded[:MAX_TEXT * 2].decode('utf-16-le', errors='ignore'), len(encoded) > MAX_TEXT * 2


class AttachmentProcessInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    operation: Literal['extract', 'ocr', 'transcribe']
    password: str | None = None

    @field_validator('password', mode='before')
    @classmethod
    def bounded_password(cls, value):
        if type(value) is not str or _utf16_length(value) > 256:
            raise ValueError('Invalid transient PDF password')
        value.encode('utf-8')
        return value


def parse_process_input(value):
    return AttachmentProcessInput.model_validate(value)


def assert_bounded_image(data, media_type):
    width = height = 0
    if media_type == 'image/png' and len(data) >= 24:
        width, height = int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')
    else:
        offset = 2
        while offset + 9 < len(data):
            if data[offset] != 255:
                break
            if data[offset + 1] in (192, 193, 194):
                height = int.from_bytes(data[offset + 5:offset + 7], 'big')
                width = int.from_bytes(data[offset + 7:offset + 9], 'big')
                break
            length = int.from_bytes(data[offset + 2:offset + 4], 'big')
            if length < 2:
                break
            offset += length + 2
    if not width or not height or width * height > 16000000 or width > 16000 or height > 16000:
        raise ControlError(413, 'ocr_image_dimensions_exceeded')


async def _cancel_guard(awaitable, cancelled):
    if cancelled is None:
        return await awaitable
    if cancelled.is_set():
        awaitable.close()
        raise ControlError(400, 'attachment_processing_cancelled')
    task = asyncio.create_task(awaitable)
    signal_task = asyncio.create_task(cancelled.wait())
    try:
        done, _ = await asyncio.wait((task, signal_task), return_when=asyncio.FIRST_COMPLETED)
        if signal_task in done:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            raise ControlError(400, 'attachment_processing_cancelled')
        return await task
    finally:
        for pending in (task, signal_task):
            if not pending.done():
                pending.cancel()
        await asyncio.gather(task, signal_task, return_exceptions=True)


class NodeAttachmentParser:
    """Fixed program and dependency root selected by trusted startup, never request input."""
    def __init__(self, *, node_executable=None, module_root=None, timeout_seconds=None):
        self.node = str(Path(node_executable or shutil.which('node') or '/nonexistent-node').resolve())
        self.modules = Path(module_root or Path(__file__).resolve().parents[4] / 'node_modules').resolve()
        self.timeout_seconds = timeout_seconds
        if timeout_seconds is not None and not 0 < timeout_seconds <= 60:
            raise ValueError('Invalid parser deadline')

    async def parse(self, data, extension, command, *, cancelled=None):
        if not data or len(data) > MAX_BYTES:
            raise ControlError(413, 'attachment_size_limit')
        if cancelled is not None and cancelled.is_set():
            raise ControlError(400, 'attachment_processing_cancelled')
        if command.operation not in ('extract', 'ocr'):
            raise ControlError(400, 'invalid_parser_operation')
        if extension not in (('png', 'jpg', 'jpeg') if command.operation == 'ocr' else ('pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp')):
            raise ControlError(415, 'attachment_parser_format_refused')
        return await _cancel_guard(self._parse(bytes(data), extension, command), cancelled)

    async def _parse(self, data, extension, command):
        process = None
        tasks = []
        with tempfile.TemporaryDirectory(prefix='openbot-parser-') as directory:
            try:
                # The permission policy confines ordinary JS filesystem access. Native parser
                # bindings remain trusted reviewed dependencies, not a claimed OS sandbox.
                args = ('--permission', '--allow-worker', '--allow-addons',
                        '--allow-fs-read=' + str(self.modules), '--allow-fs-read=' + str(PARSER_WORKER),
                        '--allow-fs-read=' + directory, '--allow-fs-write=' + directory,
                        '--max-old-space-size=256', '--max-semi-space-size=32', '--stack-size=4096',
                        '--import', str(PARSER_WORKER), str(PARSER_WORKER), str(self.modules), directory)
                # Acquire the PID synchronously before connecting pipes so cancellation can
                # always kill/reap the entire process group, including early startup failures.
                process = PipeProcess(self.node, args, cwd=directory, env={'LANG': 'C.UTF-8'})
                deadline = min(self.timeout_seconds or 60, 60 if command.operation == 'ocr' else 30)
                async with asyncio.timeout(deadline):
                    await process.connect()
                    header = {'operation': command.operation, 'extension': extension, 'size': len(data)}
                    if command.password is not None:
                        header['password'] = command.password

                    async def write():
                        process.stdin.write(json.dumps(header).encode() + b'\n' + data)
                        await process.stdin.drain()
                        process.close_stdin()

                    async def read(stream, maximum):
                        result = bytearray()
                        while chunk := await stream.read(min(65536, maximum + 1 - len(result))):
                            result.extend(chunk)
                            if len(result) > maximum:
                                raise ControlError(413, 'parser_output_limit')
                        return bytes(result)

                    tasks = [asyncio.create_task(write()), asyncio.create_task(read(process.stdout, MAX_RESPONSE)),
                             asyncio.create_task(read(process.stderr, 65536)), asyncio.create_task(process.wait())]
                    _, output, _, code = await asyncio.gather(*tasks)
                    if code:
                        raise ControlError(413, 'attachment_parser_stopped')
                    result = json.loads(output)
                    if type(result) is dict and set(result) == {'error'}:
                        code = result['error']
                        if code not in ('pdf_password_required', 'parser_dependency_unavailable', 'attachment_parsing_failed'):
                            code = 'attachment_parsing_failed'
                        raise ControlError(503 if code == 'parser_dependency_unavailable' else 400, code)
                    if (type(result) is not dict or set(result) != {'text', 'truncated'}
                            or type(result['text']) is not str or type(result['truncated']) is not bool
                            or _utf16_length(result['text']) > MAX_TEXT):
                        raise ControlError(503, 'invalid_parser_response')
                    return result
            except TimeoutError:
                raise ControlError(413, 'attachment_processing_timed_out') from None
            except (OSError, ValueError, TypeError, KeyError):
                raise ControlError(503, 'attachment_parser_unavailable') from None
            finally:
                if process is not None:
                    with suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                    process.close_stdin()
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    await process.wait()
                    process.close_pipes()


class _BoundedAudioTransport(httpx2.AsyncBaseTransport):
    """Cap raw provider/error bytes before the official SDK parses or buffers them."""
    def __init__(self, inner):
        self.inner = inner
        self.failure = None

    async def handle_async_request(self, request):
        if request.method != 'POST' or str(request.url) != 'https://api.openai.com/v1/audio/transcriptions':
            raise ControlError(415, 'transcription_endpoint_refused')
        response = await self.inner.handle_async_request(request)
        data = bytearray()
        try:
            async for chunk in response.aiter_bytes(chunk_size=65536):
                if len(data) + len(chunk) > MAX_RESPONSE:
                    self.failure = ControlError(413, 'transcription_response_limit')
                    raise self.failure
                data.extend(chunk)
        finally:
            await response.aclose()
        if not 200 <= response.status_code < 300:
            self.failure = ControlError(503, 'transcription_provider_unavailable')
            raise self.failure
        headers = {key: value for key, value in response.headers.items()
                   if key not in ('content-length', 'content-encoding', 'transfer-encoding')}
        return httpx2.Response(response.status_code, headers=headers, content=bytes(data), request=request)

    async def aclose(self):
        await self.inner.aclose()


class AttachmentProcessingService:
    def __init__(self, dsn, *, files, settings=None, node_executable=None, module_root=None, parser=None, transport=None):
        self._transactions = OwnerTransactions(dsn, application_name='openbot-attachment-processing')
        self.files, self.settings = files, settings
        self.parser = parser or NodeAttachmentParser(node_executable=node_executable, module_root=module_root)
        self.transport = transport
        self._active = 0

    async def verify_schema(self):
        await self._transactions.verify_schema()

    async def _snapshot(self, token, channel_id, identity, *, owner=False):
        async with self.files.lock(), self._transactions.transaction(token) as db:
            if not owner and not await (await db.execute('SELECT id FROM channels WHERE id=%s FOR SHARE', (channel_id,))).fetchone():
                raise ControlError(404, 'channel_not_found')
            item, data = self.files.owner_read(identity) if owner else self.files.read(channel_id, identity)
            if item.get('deletedAt'):
                raise ControlError(400, 'restore_attachment_before_processing')
            return item, bytes(data)

    async def process_owner(self, token, identity, value, *, cancelled=None):
        return await self.process(token,None,identity,value,cancelled=cancelled,_owner=True)

    async def process(self, token, channel_id, identity, value, *, cancelled=None, _owner=False):
        command = parse_process_input(value)
        if (not isinstance(identity,str) or not UUID.fullmatch(identity)
                or not _owner and (not isinstance(channel_id,str) or not UUID.fullmatch(channel_id))):
            raise ControlError(404, 'attachment_not_found')
        if self._active >= 2:
            raise ControlError(503, 'attachment_processing_busy')
        self._active += 1
        try:
            item, data = await self._snapshot(token, channel_id, identity, owner=_owner)
            extension = item['name'].rsplit('.', 1)[-1].lower()
            if command.password and extension != 'pdf':
                raise ControlError(400, 'password_only_supported_for_pdf')
            if cancelled is not None and cancelled.is_set():
                raise ControlError(400, 'attachment_processing_cancelled')
            if command.operation == 'transcribe':
                if not item['mediaType'].startswith(('audio/', 'video/')):
                    raise ControlError(415, 'audio_video_attachment_required')
                settings = await self.settings.active() if self.settings is not None else None
                self._audio_settings(settings)
                # Recheck Owner and attachment scope immediately before any media transfer.
                current, _ = await self._snapshot(token, channel_id, identity, owner=_owner)
                if current['sha256'] != item['sha256']:
                    raise ControlError(404, 'attachment_changed')
                result = await _cancel_guard(self._transcribe(settings, item, data), cancelled)
            else:
                if command.operation == 'ocr':
                    if item['mediaType'] not in ('image/png', 'image/jpeg'):
                        raise ControlError(415, 'ocr_image_required')
                    assert_bounded_image(data, item['mediaType'])
                elif extension not in ('pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'):
                    raise ControlError(415, 'document_extraction_not_required')
                result = await self.parser.parse(data, extension, command, cancelled=cancelled)
            if cancelled is not None and cancelled.is_set():
                raise ControlError(400, 'attachment_processing_cancelled')
            if (type(result) is not dict or set(result) != {'text', 'truncated'} or type(result['text']) is not str
                    or type(result['truncated']) is not bool or _utf16_length(result['text']) > MAX_TEXT):
                raise ControlError(503, 'invalid_parser_response')
            text, cut = _bounded_text(result['text'])
            if not text.strip(_ECMASCRIPT_WHITESPACE):
                raise ControlError(415, 'no_readable_pdf_text' if extension == 'pdf' else 'no_readable_attachment_text')
            derived = dict(text=text, truncated=result['truncated'] or cut, sha256=item['sha256'],
                           operation=command.operation, processedAt=iso_timestamp(datetime.now(timezone.utc)))
            return await self._save(token, channel_id, identity, derived, cancelled=cancelled, owner=_owner)
        except (psycopg.Error, OSError, ValueError, TypeError, KeyError, StoreUnavailable):
            raise ControlError(503, 'attachment_processing_unavailable') from None
        finally:
            self._active -= 1

    async def _save(self, token, channel_id, identity, derived, *, cancelled=None, owner=False):
        async with self.files.lock():
            prior_metadata = prior_text = None
            changed = False
            try:
                if cancelled is not None and cancelled.is_set():
                    raise ControlError(400, 'attachment_processing_cancelled')
                async with self._transactions.transaction(token) as db:
                    if not owner and not await (await db.execute('SELECT id FROM channels WHERE id=%s FOR SHARE', (channel_id,))).fetchone():
                        raise ControlError(404, 'channel_not_found')
                    current, _ = self.files.owner_read(identity) if owner else self.files.read(channel_id, identity)
                    if current.get('deletedAt') or current['sha256'] != derived['sha256']:
                        raise ControlError(404, 'attachment_changed_or_deleted')
                    prior_metadata = self.files._read(identity + '.json', 4096)
                    try:
                        prior_text = self.files._read(identity + '.text.json', MAX_RESPONSE)
                    except FileNotFoundError:
                        pass
                    updated = {**current, 'processing': dict(operation=derived['operation'], characters=_utf16_length(derived['text']),
                               truncated=derived['truncated'], processedAt=derived['processedAt'])}
                    if cancelled is not None and cancelled.is_set():
                        raise ControlError(400, 'attachment_processing_cancelled')
                    changed = True
                    self.files._write(identity + '.text.json', json.dumps(derived, ensure_ascii=False).encode('utf-8'))
                    self.files._write(identity + '.json', json.dumps(updated, ensure_ascii=False).encode('utf-8'))
                    return updated
            except BaseException:
                if changed:
                    if prior_text is None:
                        self.files._remove(identity + '.text.json')
                    else:
                        self.files._write(identity + '.text.json', prior_text)
                    self.files._write(identity + '.json', prior_metadata)
                raise

    @staticmethod
    def _audio_settings(settings):
        if (type(settings) is not dict or settings.get('provider') != 'openai'
                or settings.get('agentEnabled') is not True or not settings.get('agentEnabledAt')
                or type(settings.get('apiKey')) is not str or not settings['apiKey']):
            raise ControlError(415, 'enabled_openai_transcription_required')
        endpoint = urlsplit(settings.get('baseUrl') or 'https://api.openai.com/v1')
        if (endpoint.scheme != 'https' or endpoint.hostname != 'api.openai.com' or endpoint.port not in (None,443)
                or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment or endpoint.path.rstrip('/') != '/v1'):
            raise ControlError(415, 'transcription_endpoint_refused')
        if any(key in os.environ for key in ('OPENAI_CUSTOM_HEADERS', 'OPENAI_LOG')):
            raise ControlError(503, 'ambient_transcription_configuration_refused')

    async def _transcribe(self, settings, item, data):
        transport = _BoundedAudioTransport(self.transport or httpx2.AsyncHTTPTransport(retries=0, trust_env=False))
        client = httpx2.AsyncClient(transport=transport, follow_redirects=False, trust_env=False, verify=True)
        try:
            async with asyncio.timeout(90), AsyncOpenAI(api_key=settings['apiKey'], base_url='https://api.openai.com/v1',
                    max_retries=0, organization='', project='', admin_api_key='', webhook_secret='', http_client=client) as sdk:
                response = await sdk.audio.transcriptions.create(model='whisper-1', response_format='json',
                                                                 file=(item['name'], data, item['mediaType']))
                text, truncated = _bounded_text(response.text)
                return dict(text=text, truncated=truncated)
        except ControlError:
            raise
        except asyncio.CancelledError:
            raise
        except Exception:
            if transport.failure is not None:
                raise transport.failure from None
            raise ControlError(503, 'transcription_provider_unavailable') from None
        finally:
            await client.aclose()
