"""Actual PostgreSQL/private blob recovery; no real model or billing account."""
import asyncio
from dataclasses import replace
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import psycopg
import pytest
pytest.importorskip('pydantic_ai', reason='optional Worker SDK profile')
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'agent-runtime-python/src'))
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai.usage import RequestUsage
from openbot_agent_runtime.contracts import ModelStepRequest
from openbot_server import work_model_activity as model
from openbot_server.work_model_receipts import ModelReceipts
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_values import WorkConflict, canonical
from openbot_server.database import StoreUnavailable
from test_work_postgres import new, store


def response():
    return ModelResponse([TextPart('persisted answer')], usage=RequestUsage(input_tokens=2, output_tokens=1))


def configuration(**changes):
    return dict(source='singleton', revision='configured-revision', provider='openai-responses',
        model='gpt-4o-mini', baseUrl='https://api.openai.com/v1', protocol='responses-v1') | changes


def test_model_configuration_is_secret_free_and_part_of_operation(fixture, tmp_path):
    async def check():
        _, _, _, call, _ = await setup(fixture, tmp_path)
        provider = AsyncMock(return_value=response())
        original = configuration()
        assert (await call(provider, configuration=original)).parts[0].content == 'persisted answer'
        assert await call(provider, configuration=original)
        with pytest.raises(WorkConflict, match='model_operation_changed'):
            await call(provider, configuration=configuration(revision='rotated'))
        from openbot_server.work_values import InvalidWork
        for changed in (configuration(apiKey='must-never-persist'), configuration(model='other'),
                        configuration(baseUrl='https://name:secret@api.example/v1'),
                        configuration(baseUrl='https://api.example/v1?key=secret')):
            with pytest.raises(InvalidWork): await call(provider, configuration=changed)
        assert provider.await_count == 1
    asyncio.run(check())


@pytest.mark.parametrize('mode', ['false', 'synchronous', 'raises'])
def test_product_admission_callback_refuses_before_model_or_receipt(fixture, tmp_path, mode):
    async def check():
        service, task, receipts, call, _ = await setup(fixture, tmp_path)
        provider = AsyncMock(return_value=response())
        async def guard(db, selected, action):
            assert selected['id'] == task['id'] and action['intent']['kind'] == 'model'
            if mode == 'raises': raise WorkConflict('fixture_configuration_changed')
            return False
        with pytest.raises(WorkConflict):
            await call(provider, admission_check=(lambda *_:True) if mode == 'synchronous' else guard)
        current = await service.snapshot(fixture['token'], task['id'])
        assert current['actions'][0]['status'] == 'proposed' and current['usage']['spentTokens'] == 0
        assert provider.await_count == 0 and list(receipts.files.directory.iterdir()) == []
    asyncio.run(check())


async def setup(fixture, tmp_path):
    service = store(fixture)
    task = await new(fixture, service, 20)
    root = tmp_path / 'observations'; root.mkdir(mode=0o700)
    receipts = ModelReceipts(service, LocalWorkFiles(root))
    identity = SimpleNamespace(task_id=task['id'], run_id=task['runs'][0]['id'],
        namespace='default', workflow_id='openbot-work-v1-' + task['runs'][0]['id'],
        engine_run_id='original-engine', first_run_id='original-engine')
    request = ModelStepRequest(step=1, messages=[ModelRequest([UserPromptPart('question')])], tools=())
    scope = dict(expected_namespace='default', expected_queue='queue', expected_workflow_type='worker')
    config = dict(provider_id='openai-responses', model_id='gpt-4o-mini', max_output_tokens=4, reserved_tokens=6)
    async def call(provider, **overrides):
        values = dict(request=request, receipts=receipts, provider=provider) | overrides
        with patch.object(model, '_bind_activity_identity', AsyncMock(return_value=(identity, 'model-1'))):
            return await model.execute_model_activity(service, object(), **scope, **config, **values)
    return service, task, receipts, call, request


def test_received_model_result_reused_after_expired_claim(fixture, tmp_path):
    async def check():
        service, task, receipts, call, request = await setup(fixture, tmp_path)
        provider = AsyncMock(return_value=response())
        first = await call(provider)
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("UPDATE work_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE run_id=%s",
                       (task['runs'][0]['id'],))
        fresh = ModelReceipts(service, LocalWorkFiles(receipts.files.directory))
        second = await call(provider, receipts=fresh, request=replace(request, step=99))
        assert second == first
        assert provider.await_count == 1
        snapshot = await service.snapshot(fixture['token'], task['id'])
        assert snapshot['usage']['spentTokens'] == 3 and snapshot['usage']['reservedTokens'] == 0
        assert len(snapshot['actions']) == 1
    asyncio.run(check())


def test_receipt_committed_before_activity_exit_recovers_without_call(fixture, tmp_path):
    async def check():
        service, task, receipts, call, _ = await setup(fixture, tmp_path)
        provider = AsyncMock(return_value=response())
        original = receipts.save
        async def interrupted(*args, **kwargs):
            await original(*args, **kwargs)
            raise asyncio.CancelledError()
        with patch.object(receipts, 'save', interrupted), pytest.raises(asyncio.CancelledError):
            await call(provider)
        result = await call(provider)
        assert result.parts[0].content == 'persisted answer' and provider.await_count == 1
        snapshot = await service.snapshot(fixture['token'], task['id'])
        assert snapshot['actions'][0]['status'] == 'applied'
    asyncio.run(check())


def test_missing_model_reply_never_reissues_or_refunds(fixture, tmp_path):
    async def check():
        service, task, _, call, _ = await setup(fixture, tmp_path)
        provider = AsyncMock(side_effect=TimeoutError('synthetic provider response lost'))
        for _ in range(2):
            with pytest.raises(WorkConflict, match='model_observation_unknown'):
                await call(provider)
        assert provider.await_count == 1
        snapshot = await service.snapshot(fixture['token'], task['id'])
        assert snapshot['actions'][0]['status'] == 'unknown'
        assert snapshot['usage']['reservedTokens'] == 6 and snapshot['usage']['spentTokens'] == 0
    asyncio.run(check())


def test_changed_request_cannot_reuse_operation_identity(fixture, tmp_path):
    async def check():
        _, _, _, call, request = await setup(fixture, tmp_path)
        provider = AsyncMock(return_value=response())
        await call(provider)
        changed = replace(request, messages=[ModelRequest([UserPromptPart('different')])])
        with pytest.raises(WorkConflict, match='model_operation_changed'):
            await call(provider, request=changed)
        assert provider.await_count == 1
    asyncio.run(check())


@pytest.mark.parametrize('before_settlement', [True, False])
def test_corrupted_blob_never_triggers_model_replay(fixture, tmp_path, before_settlement):
    async def check():
        service, task, receipts, call, _ = await setup(fixture, tmp_path)
        provider = AsyncMock(return_value=response())
        if before_settlement:
            original = receipts.save
            async def interrupted(*args, **kwargs):
                await original(*args, **kwargs)
                raise asyncio.CancelledError()
            with patch.object(receipts, 'save', interrupted), pytest.raises(asyncio.CancelledError):
                await call(provider)
        else:
            await call(provider)
        with psycopg.connect(fixture['dsn']) as db:
            digest = db.execute('SELECT sha256 FROM work_model_receipts WHERE task_id=%s', (task['id'],)).fetchone()[0]
        (receipts.files.directory / digest).write_bytes(b'corrupt')
        with pytest.raises((WorkConflict, StoreUnavailable)):
            await call(provider)
        assert provider.await_count == 1
        snapshot = await service.snapshot(fixture['token'], task['id'])
        if before_settlement:
            assert snapshot['actions'][0]['status'] == 'unknown' and snapshot['usage']['reservedTokens'] == 6
        else:
            assert snapshot['actions'][0]['status'] == 'applied' and snapshot['usage']['spentTokens'] == 3
    asyncio.run(check())


def test_receipt_immutable_scoped_and_historical_after_cancel(fixture, tmp_path):
    async def check():
        service, task, receipts, call, _ = await setup(fixture, tmp_path)
        answer = response()
        async def late_provider(_):
            await service.cancel(fixture['token'], task['id'])
            return answer
        await call(late_provider)  # trusted receipt settlement; Runtime's guard still refuses continuation
        snap = await service.snapshot(fixture['token'], task['id'])
        action = snap['actions'][0]
        assert snap['status'] == 'cancelled' and not snap['authorityActive'] and not snap['artifacts']
        assert action['status'] == 'applied' and snap['usage']['spentTokens'] == 3
        scope = dict(task_id=task['id'], run_id=task['runs'][0]['id'], intent_digest=action['intentDigest'])
        await receipts.save(action['id'], **scope, response=answer)
        changed = replace(answer, parts=[TextPart('replacement')])
        with pytest.raises(WorkConflict, match='model_receipt_settlement_conflict'):
            await receipts.save(action['id'], **scope, response=changed)
        with pytest.raises(WorkConflict, match='scope_mismatch'):
            await receipts.load(action['id'], **(scope | {'task_id': 'other'}))
    asyncio.run(check())


def test_proposed_action_does_not_accept_an_observation(fixture, tmp_path):
    async def check():
        service, task, receipts, _, _ = await setup(fixture, tmp_path)
        run_id = task['runs'][0]['id']
        fence = await service.claim(task['id'], run_id, 'proposed')
        intent = {'kind': 'model'}
        action = await service.propose(task['id'], run_id, fence=fence, action_key='proposed',
            intent=intent, reserved_tokens=6, requires_approval=False)
        with pytest.raises(WorkConflict, match='not_admitted'):
            await receipts.save(action, task_id=task['id'], run_id=run_id,
                                intent_digest=canonical(intent)[1], response=response())
        assert list(receipts.files.directory.iterdir()) == []
    asyncio.run(check())


@pytest.mark.parametrize('field,value', [('actual_tokens', 4), ('sha256', 'a' * 64)])
def test_applied_receipt_must_match_original_settlement(fixture, tmp_path, field, value):
    async def check():
        service, task, receipts, call, _ = await setup(fixture, tmp_path)
        provider = AsyncMock(return_value=response())
        await call(provider)
        with psycopg.connect(fixture['dsn']) as db:
            # Deliberate owned corruption after settlement; no provider call may hide it.
            from psycopg import sql
            db.execute(sql.SQL('UPDATE work_model_receipts SET {}=%s WHERE task_id=%s').format(
                sql.Identifier(field)), (value, task['id']))
        with pytest.raises(WorkConflict, match='settlement_conflict'):
            await call(provider)
        assert provider.await_count == 1
    asyncio.run(check())


@pytest.mark.parametrize('changed_usage', [False, True])
def test_missing_applied_receipt_cannot_be_replaced(fixture, tmp_path, changed_usage):
    async def check():
        service, task, receipts, call, _ = await setup(fixture, tmp_path)
        answer = response()
        await call(AsyncMock(return_value=answer))
        snap = await service.snapshot(fixture['token'], task['id']); action = snap['actions'][0]
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('DELETE FROM work_model_receipts WHERE task_id=%s', (task['id'],))
        before = set(receipts.files.directory.iterdir())
        changed = replace(answer, parts=[TextPart('replacement')])
        if changed_usage:
            changed = replace(answer, usage=RequestUsage(input_tokens=3, output_tokens=1))
        scope = dict(task_id=task['id'], run_id=task['runs'][0]['id'], intent_digest=action['intentDigest'])
        with pytest.raises(WorkConflict, match='settlement_conflict'):
            await receipts.save(action['id'], **scope, response=changed)
        assert set(receipts.files.directory.iterdir()) == before
        await receipts.save(action['id'], **scope, response=answer)
        assert (await receipts.load(action['id'], **scope)).response == answer
    asyncio.run(check())


def test_blob_without_metadata_is_not_a_receipt_or_permission_to_retry(fixture, tmp_path):
    async def check():
        service, task, receipts, call, _ = await setup(fixture, tmp_path)
        provider = AsyncMock(return_value=response())
        original = receipts.files.put
        def interrupted(data):
            original(data)
            raise asyncio.CancelledError()
        with patch.object(receipts.files, 'put', interrupted), pytest.raises(asyncio.CancelledError):
            await call(provider)
        assert len(list(receipts.files.directory.iterdir())) == 1
        with pytest.raises(WorkConflict, match='model_observation_unknown'):
            await call(provider)
        snap = await service.snapshot(fixture['token'], task['id'])
        assert provider.await_count == 1 and snap['actions'][0]['status'] == 'unknown'
        assert snap['usage']['reservedTokens'] == 6 and snap['usage']['spentTokens'] == 0
    asyncio.run(check())
