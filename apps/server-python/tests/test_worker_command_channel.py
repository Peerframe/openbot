"""Real loopback ASGI/WebSocket peer; no protected Host, SQL authority or effects."""
import asyncio
from contextlib import asynccontextmanager
import json
from uuid import uuid4

import pytest
from websockets.exceptions import ConnectionClosed

from openbot_server.worker_host_commands import CommandChannelConfiguration, CommandChannelError
from openbot_server.worker_host_identity import digest_secret
from openbot_server.worker_host_protocol import parse_frame, parse_negotiated_frame
from test_worker_host_socket import live_server, hello, client, receive, send, message, now


def command(kind='ready', *, request=None, preparation=None, **payload):
    preparation = preparation or str(uuid4())
    return {'type': 'work.command.' + kind, 'protocolVersion': '0.10.0', 'nodeId': 'synthetic-host',
            'requestId': request or preparation, 'preparationId': preparation,
            'payload': payload or {'token': 'a.b.c'}}


def opt_hello():
    return hello(commandChannel={'protocolVersion': '0.10.0'})


@asynccontextmanager
async def connected(callback=None):
    pending, available, unavailable = [], [], []
    config = CommandChannelConfiguration(callback or (lambda item: (pending.append(item), True)[1]),
                                         available.append, unavailable.append)
    async with live_server(options={'command_channel': config}) as (registry, url, _, events):
        async with client(url) as ws:
            await send(ws, opt_hello())
            ack = await receive(ws)
            await asyncio.sleep(0)
            handle = registry.commands.connection('synthetic-host')
            yield registry, ws, handle, pending, ack, url, events, unavailable


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate(): await asyncio.sleep(.005)


def test_real_explicit_negotiation_guard_digest_and_ordinary_ack():
    async def run():
        async with connected() as (registry, ws, handle, pending, ack, _, _, _):
            assert ack['protocolVersion'] == '0.9.0'
            assert ack['commandChannel']['protocolVersion'] == '0.10.0'
            async with registry.commands.guard(handle) as live:
                assert live.connection_id == ack['commandChannel']['connectionId']
                assert live.credential_digest == digest_secret('credential', 'obn_' + 'x' * 43)
                with pytest.raises(CommandChannelError):
                    await registry.commands.send(handle, command('prepare_authorize'))
            assert 'commandChannel' not in registry.list()[0]
            assert 'credential' not in json.dumps(registry.list())
            await send(ws, message('node.heartbeat', 'synthetic-host', activeRunIds=[], sentAt=now()))
            assert 'commandChannel' not in await receive(ws)
            await registry.commands.send(handle, command('prepare_authorize'))
            assert (await receive(ws))['type'] == 'work.command.prepare_authorize'
            await send(ws, command())
            await until(lambda: pending)
            item = pending[0]
            snapshot = item.frame
            snapshot['nodeId'] = 'mutated'
            assert item.frame['nodeId'] == 'synthetic-host'
            reply = {**item.frame, 'type': 'work.command.error',
                     'payload': {'status': 'denied', 'code': 'authority_changed'}}
            await registry.commands.reply(item, reply)
            assert await receive(ws) == reply
            with pytest.raises(CommandChannelError): await registry.commands.reply(item, reply)
            registry.commands.complete(item)
            with pytest.raises(CommandChannelError): registry.commands.complete(item)
    asyncio.run(run())


def test_default_rejects_extension_and_configured_legacy_stays_legacy():
    async def run():
        async with live_server() as (_, url, _, _):
            async with client(url) as ws:
                await send(ws, opt_hello())
                assert (await receive(ws))['accepted'] is False
                with pytest.raises(ConnectionClosed): await ws.recv()
        config = CommandChannelConfiguration(lambda _: True)
        async with live_server(options={'command_channel': config}) as (registry, url, _, _):
            async with client(url) as ws:
                await send(ws, hello())
                assert 'commandChannel' not in await receive(ws)
                with pytest.raises(CommandChannelError): registry.commands.connection('synthetic-host')
                await send(ws, command())
                assert (await receive(ws))['accepted'] is False
    asyncio.run(run())


@pytest.mark.parametrize('mutation', ['duplicate', 'float', 'exponent', 'unsafe', 'nan', 'oversize', 'wrong_node'])
def test_original_command_bytes_fail_strict_before_notification(mutation):
    async def run():
        async with connected() as (_, ws, _, pending, _, _, _, _):
            value = command('input_ack', fileIndex=0, nextOffset=1)
            raw = json.dumps(value)
            if mutation == 'duplicate': raw = raw.replace('"fileIndex": 0', '"fileIndex": 1, "fileIndex": 0')
            if mutation == 'float': raw = raw.replace('"nextOffset": 1', '"nextOffset": 1.0')
            if mutation == 'exponent': raw = raw.replace('"nextOffset": 1', '"nextOffset": 1e0')
            if mutation == 'unsafe': raw = raw.replace('"nextOffset": 1', '"nextOffset": 9007199254740992')
            if mutation == 'nan': raw = raw.replace('"nextOffset": 1', '"nextOffset": NaN')
            if mutation == 'oversize': raw = ' ' * 32768 + raw
            if mutation == 'wrong_node': raw = raw.replace('synthetic-host', 'other-node')
            await ws.send(raw)
            # Validation can emit one finite legacy rejection before closing; never a command reply.
            try:
                while True: assert (await receive(ws)).get('accepted') is False
            except ConnectionClosed: pass
            assert pending == []
    asyncio.run(run())


def test_pending_notification_does_not_block_receive_and_shared_cap_closes():
    async def run():
        async with connected() as (registry, ws, handle, pending, _, _, events, _):
            for _ in range(4): await send(ws, command())
            await until(lambda: len(pending) == 4)
            await send(ws, message('node.heartbeat', 'synthetic-host', activeRunIds=[], sentAt=now()))
            assert (await receive(ws))['accepted'] is True
            assert any(event[0] == 'updated' for event in events)
            with pytest.raises(CommandChannelError):
                await registry.commands.send(handle, command('prepare_authorize'))
            await until(lambda: registry.list() == [])
            for item in pending:
                with pytest.raises(CommandChannelError): registry.commands.complete(item)
    asyncio.run(run())


@pytest.mark.parametrize('mode', ['messages', 'bytes'])
def test_incoming_pending_caps(mode):
    async def run():
        async with connected() as (registry, ws, _, pending, _, _, _, _):
            values = [command() for _ in range(5)]
            if mode == 'bytes':
                import base64
                values = [command('output_chunk', fileIndex=0, offset=0,
                                  data=base64.b64encode(b'x'*16384).decode()) for _ in range(3)]
            for value in values: await send(ws, value)
            await until(lambda: registry.list() == [])
            assert len(pending) == {'messages':4, 'bytes':2}[mode]
    asyncio.run(run())


@pytest.mark.parametrize('stream', ['input_ack_ready', 'lookup_result_output_chunk'])
def test_same_request_stream_frames_are_distinct_pending_observations(stream):
    async def run():
        async with connected() as (registry, ws, handle, pending, _, _, _, _):
            preparation = str(uuid4())
            request = preparation if stream == 'input_ack_ready' else str(uuid4())
            if stream == 'input_ack_ready':
                first = command('input_ack', request=request, preparation=preparation,
                                fileIndex=0, nextOffset=1)
                second = command('ready', request=request, preparation=preparation)
            else:
                first = command('lookup_result', request=request, preparation=preparation)
                second = command('output_chunk', request=request, preparation=preparation,
                                 fileIndex=0, offset=0, data='eA==')
            # The consumer deliberately completes neither notification before the second arrives.
            await ws.send(json.dumps(first))
            await ws.send(json.dumps(second))
            await until(lambda: len(pending) == 2)
            assert [item.frame for item in pending] == [first, second]
            assert pending[0] is not pending[1]
            assert len(handle.items) == 2 and len(handle.pending) == 2
            second_size = handle.items[pending[1]][0]
            registry.commands.complete(pending[0])
            with pytest.raises(CommandChannelError): registry.commands.complete(pending[0])
            assert handle.bytes == second_size and pending[1] in handle.items
            if stream == 'lookup_result_output_chunk':
                reply = command('output_ack', request=request, preparation=preparation,
                                fileIndex=0, nextOffset=1)
                await registry.commands.reply(pending[1], reply)
                assert await receive(ws) == reply
                with pytest.raises(CommandChannelError): await registry.commands.reply(pending[1], reply)
            registry.commands.complete(pending[1])
            assert handle.bytes == 0 and not handle.items and not handle.pending
            async with registry.commands.guard(handle): pass
    asyncio.run(run())


@pytest.mark.parametrize('mode', ['reject', 'throw', 'awaitable'])
def test_bad_notification_fails_closed(mode):
    async def unfinished(): return True
    def callback(_):
        if mode == 'throw': raise RuntimeError('synthetic private error')
        return unfinished() if mode == 'awaitable' else False
    async def run():
        async with connected(callback) as (registry, ws, _, _, _, _, _, _):
            await send(ws, command())
            await until(lambda: registry.list() == [])
    asyncio.run(run())


def test_pending_timeout_closes_without_response_or_retry(monkeypatch):
    import openbot_server.worker_host_commands as module
    monkeypatch.setattr(module, 'TIMEOUT', .05)
    async def run():
        async with connected() as (registry, ws, _, pending, _, _, _, _):
            await send(ws, command())
            await until(lambda: pending)
            with pytest.raises(ConnectionClosed): await ws.recv()
            assert len(pending) == 1 and registry.list() == []
            with pytest.raises(CommandChannelError): registry.commands.complete(pending[0])
    asyncio.run(run())


def test_replacement_revoke_and_foreign_pending_never_write_new_socket():
    async def run():
        async with connected() as (registry, ws, old, pending, ack, url, _, unavailable):
            await send(ws, command())
            await until(lambda: pending)
            item = pending[0]
            async with client(url) as replacement:
                await send(replacement, opt_hello())
                new_ack = await receive(replacement)
                assert new_ack['commandChannel']['connectionId'] != ack['commandChannel']['connectionId']
                new = registry.commands.connection('synthetic-host')
                with pytest.raises(CommandChannelError):
                    async with registry.commands.guard(old): pass
                with pytest.raises(CommandChannelError):
                    await registry.commands.reply(item, {**item.frame, 'type':'work.command.prepare_authorize'})
                with pytest.raises(CommandChannelError): registry.commands.complete(item)
                async with registry.commands.guard(new) as live:
                    assert live.connection_id == new_ack['commandChannel']['connectionId']
                await send(replacement, command())
                await until(lambda: len(pending) == 2)
                wrong = {**pending[1].frame, 'type':'work.command.prepare_authorize', 'requestId':str(uuid4())}
                with pytest.raises(CommandChannelError): await registry.commands.reply(pending[1], wrong)
                registry.commands.complete(pending[1])
                async with registry.identity_guard('synthetic-host'):
                    await registry.disconnect('synthetic-host')
                with pytest.raises(CommandChannelError): await registry.commands.send(new, command('prepare_authorize'))
                assert len(unavailable) == 2
    asyncio.run(run())


def test_negotiation_schema_rejects_fields_and_wrong_ack_state():
    for channel in ({'protocolVersion':'0.9.0'}, {'protocolVersion':'0.10.0','extra':True}, None):
        with pytest.raises(ValueError): parse_negotiated_frame(hello(commandChannel=channel))
    with pytest.raises(ValueError): parse_frame(opt_hello())
    for accepted in (False, True):
        ack={'type':'server.ack','protocolVersion':'0.9.0','accepted':accepted,'receivedAt':now(),
             'commandChannel':{'protocolVersion':'0.10.0','connectionId':'bad'}}
        with pytest.raises(ValueError): parse_negotiated_frame(ack, server=True)


@pytest.mark.parametrize('mode', ['timeout', 'cancel', 'failed_write'])
def test_blocked_or_unknown_write_closes_once_and_never_resends(monkeypatch, mode):
    import openbot_server.worker_host_commands as module
    monkeypatch.setattr(module, 'TIMEOUT', .05)
    async def run():
        async with connected() as (registry, _, handle, _, _, _, _, unavailable):
            calls = []
            started = asyncio.Event()
            async def blocked(raw):
                calls.append(raw); started.set()
                if mode == 'failed_write': raise OSError('synthetic private failure')
                await asyncio.Event().wait()
            monkeypatch.setattr(handle.connection.socket, 'send_text', blocked)
            task = asyncio.create_task(registry.commands.send(handle, command('prepare_authorize')))
            await started.wait()
            if mode == 'cancel': task.cancel()
            with pytest.raises(asyncio.CancelledError if mode == 'cancel' else CommandChannelError): await task
            with pytest.raises(CommandChannelError): await registry.commands.send(handle, command('prepare_authorize'))
            assert len(calls) == 1 and len(unavailable) == 1 and registry.list() == []
    asyncio.run(run())


def test_active_outbound_counted_and_guard_flag_is_task_local(monkeypatch):
    async def run():
        async with connected() as (registry, ws, handle, _, _, _, _, _):
            proceed = asyncio.Event()
            async def independent():
                await proceed.wait()
                await registry.commands.send(handle, command('prepare_authorize'))
            task = asyncio.create_task(independent())
            async with registry.commands.guard(handle):
                proceed.set()
                await task  # This already-existing unrelated task did not enter the SQL guard.
            assert (await receive(ws))['type'] == 'work.command.prepare_authorize'
            started, release = asyncio.Event(), asyncio.Event()
            calls = []
            async def blocked(raw):
                calls.append(raw); started.set(); await release.wait()
            monkeypatch.setattr(handle.connection.socket, 'send_text', blocked)
            active = asyncio.create_task(registry.commands.send(handle, command('prepare_authorize')))
            await started.wait()
            queued = [asyncio.create_task(registry.commands.send(handle, command('prepare_authorize'))) for _ in range(3)]
            await asyncio.sleep(0)
            with pytest.raises(CommandChannelError): await registry.commands.send(handle, command('prepare_authorize'))
            release.set()
            results = await asyncio.gather(active, *queued, return_exceptions=True)
            assert all(isinstance(item, CommandChannelError) for item in results)
            assert len(calls) == 1
    asyncio.run(run())


def test_clear_binding_cannot_select_a_previous_connection_uuid():
    async def run():
        async with connected() as (registry, ws, handle, _, ack, _, _, _):
            frame = command('prepare_open')
            frame['payload'] = dict(nodeId='synthetic-host', providerId='provider', enforcementKeyId='key',
                ledgerId=str(uuid4()), taskId='t', runId='r', actionId='a', preparationId=frame['preparationId'],
                connectionId=str(uuid4()), originalEpoch=1, authorityGeneration=1,
                profileDigest='a'*64, intentDigest='b'*64, operationFingerprint='c'*64)
            with pytest.raises(CommandChannelError): await registry.commands.send(handle, frame)
            frame['payload']['connectionId'] = ack['commandChannel']['connectionId']
            await registry.commands.send(handle, frame)
            assert await receive(ws) == frame
    asyncio.run(run())


def test_legacy_browser_command_roundtrip_on_negotiated_socket():
    from datetime import datetime, timedelta, timezone
    from openbot_server.models import iso_timestamp
    from test_browser_sessions import CAP
    async def run():
        config = CommandChannelConfiguration(lambda _: True)
        async with live_server(options={'command_channel':config}) as (registry, url, _, _):
            async with client(url) as ws:
                await send(ws, hello(commandChannel={'protocolVersion':'0.10.0'}, capabilityManifest=[CAP]))
                assert (await receive(ws))['accepted']
                value = dict(type='browser.command',protocolVersion='0.9.0',nodeId='synthetic-host',
                    requestId=str(uuid4()),sessionId=str(uuid4()),botId=str(uuid4()),action={'kind':'observe'},
                    expiresAt=iso_timestamp(datetime.now(timezone.utc)+timedelta(seconds=5)))
                @asynccontextmanager
                async def synthetic_authority(_): yield
                task = asyncio.create_task(registry.browser_command(value, dispatch_guard=synthetic_authority))
                assert await receive(ws) == value
                result = dict(type='browser.result',protocolVersion='0.9.0',nodeId='synthetic-host',
                    requestId=value['requestId'],sessionId=value['sessionId'],ok=False,error='unavailable')
                await send(ws, result)
                assert await task == result
                assert (await receive(ws))['accepted']
    asyncio.run(run())


def test_completed_pending_cannot_finish_a_queued_reply():
    async def run():
        async with connected() as (registry, ws, handle, pending, _, _, _, _):
            await send(ws, command())
            await until(lambda: pending)
            lock = handle.connection.send_lock
            await lock.acquire()
            reply = asyncio.create_task(registry.commands.reply(pending[0],
                {**pending[0].frame, 'type':'work.command.prepare_authorize'}))
            await asyncio.sleep(0)
            registry.commands.complete(pending[0])
            lock.release()
            with pytest.raises(CommandChannelError): await reply
            with pytest.raises(ConnectionClosed): await ws.recv()
    asyncio.run(run())


def test_raw_hello_duplicate_extension_rejected_before_authentication():
    async def run():
        config = CommandChannelConfiguration(lambda _: True)
        async with live_server(options={'command_channel':config}) as (registry, url, _, events):
            async with client(url) as ws:
                value = json.dumps(opt_hello())
                value = value.replace('"commandChannel":', '"commandChannel": {}, "commandChannel":')
                await ws.send(value)
                assert (await receive(ws))['accepted'] is False
                assert registry.list() == [] and events == []
    asyncio.run(run())


def test_expired_pending_cannot_be_used_when_timer_callback_was_delayed(monkeypatch):
    import openbot_server.worker_host_commands as module
    monkeypatch.setattr(module, 'TIMEOUT', .03)
    async def run():
        async with connected() as (registry, ws, handle, pending, _, _, _, _):
            await send(ws, command())
            await until(lambda: pending)
            # Suppress delivery of the scheduled callback, preserving its original deadline.
            handle.items[pending[0]][1].cancel()
            await asyncio.sleep(.04)
            with pytest.raises(CommandChannelError): registry.commands.complete(pending[0])
            assert registry.list() == []
    asyncio.run(run())


def test_bad_frame_invalidates_pending_before_a_blocked_rejection_write():
    async def run():
        async with connected() as (registry, ws, handle, pending, _, _, _, _):
            await send(ws, command())
            await until(lambda: pending)
            await handle.connection.send_lock.acquire()
            try:
                raw = json.dumps(command('input_ack',fileIndex=0,nextOffset=1)).replace(
                    '"nextOffset": 1', '"nextOffset": 1.0')
                await ws.send(raw)
                await until(lambda: registry.list() == [])
                with pytest.raises(CommandChannelError): registry.commands.complete(pending[0])
            finally:
                handle.connection.send_lock.release()
    asyncio.run(run())


def test_negotiated_fields_match_the_shared_typescript_schema():
    import os
    from pathlib import Path
    import shutil
    import subprocess
    root = Path(os.environ.get('OPENBOT_PROTOCOL_ORACLE_ROOT', Path(__file__).resolve().parents[3]))
    node = shutil.which('node')
    if node is None or not (root/'node_modules/tsx').exists():
        pytest.skip('Requires installed shared protocol oracle')
    ack = {'type':'server.ack','protocolVersion':'0.9.0','accepted':True,'receivedAt':now(),
           'commandChannel':{'protocolVersion':'0.10.0','connectionId':str(uuid4())}}
    corpus = [hello(), opt_hello(), ack,
        {**ack,'accepted':False}, {**ack,'commandChannel':None},
        {**ack,'commandChannel':{**ack['commandChannel'],'extra':True}},
        {**ack,'commandChannel':{**ack['commandChannel'],'connectionId':'bad'}},
        hello(commandChannel={'protocolVersion':'0.9.0'}),
        hello(commandChannel={'protocolVersion':'0.10.0','connectionId':str(uuid4())})]
    source = '''import {nodeHelloSchema,serverAckSchema} from './packages/protocol/src/index.ts';
let text='';for await(const c of process.stdin)text+=c;
console.log(JSON.stringify(JSON.parse(text).map(v=>{const r=(v.type==='node.hello'?nodeHelloSchema:serverAckSchema).safeParse(v);return r.success?{ok:true,value:r.data}:{ok:false}})));'''
    actual = subprocess.run([node,'--import','tsx','--input-type=module','-e',source],
        input=json.dumps(corpus),text=True,capture_output=True,cwd=root,timeout=15,check=True)
    for value, expected in zip(corpus,json.loads(actual.stdout),strict=True):
        try: result={'ok':True,'value':parse_negotiated_frame(value,server=value['type']=='server.ack')}
        except ValueError: result={'ok':False}
        assert result == expected
