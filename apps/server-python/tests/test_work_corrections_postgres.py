"""Task-locked Owner corrections against the owned PostgreSQL fixture; no model or effects."""
import asyncio
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest
from pydantic import ValidationError

from openbot_server.authority import AuthenticationRequired
from openbot_server.work_corrections import CorrectionStore, CorrectionsChanged, check_context
from openbot_server.work_models import RequestCorrection, WorkCorrection, WorkSnapshot
from openbot_server.work_values import InvalidWork, WorkConflict, WorkNotFound
from test_work_postgres import evidence, new, store
from test_work_publication_postgres import publish, service as file_service, task_and_claim


async def setup(fixture):
    service = store(fixture)
    task = await new(fixture, service, 100)
    run_id = task['runs'][0]['id']
    corrections = CorrectionStore(service)
    await corrections.enable(task['id'], run_id)
    fence = await service.claim(task['id'], run_id, 'correction-fixture')
    context = await corrections.freeze(task['id'], run_id, 'initial-segment')
    return service, task, corrections, fence, context


async def request(fixture, corrections, task, **changes):
    values = dict(run_id=task['runs'][0]['id'], instruction='Keep row order and round nothing.',
                  request_key=str(uuid4()), expected_sequence=0)
    values.update(changes)
    return await corrections.request(fixture['token'], task['id'], **values)


async def propose(service, task, fence, context, **changes):
    values = dict(fence=fence, action_key='write', intent={'operation': 'fixture.update'},
                  reserved_tokens=6, requires_approval=False, correction_context=context['id'])
    values.update(changes)
    return await service.propose(task['id'], fence.run_id, **values)


async def checked_context(service, task_id, run_id, context_id, *, current=True):
    async with service._transaction(trusted=True) as db:
        task = await service._task(db, task_id)
        return await check_context(db, task, run_id, context_id, current=current)


def test_owner_auth_exact_run_profile_and_input_bounds(fixture):
    async def check():
        service = store(fixture); task = await new(fixture, service)
        corrections = CorrectionStore(service); run_id = task['runs'][0]['id']
        with pytest.raises(AuthenticationRequired):
            await corrections.request(None, task['id'], run_id=run_id, instruction='correct',
                                      request_key=str(uuid4()), expected_sequence=0)
        with pytest.raises(WorkConflict, match='corrections_unsupported'):
            await request(fixture, corrections, task)
        with pytest.raises(WorkNotFound):
            await request(fixture, corrections, task, run_id='unknown-run')
        assert await checked_context(service, task['id'], run_id, None) is None
        await corrections.enable(task['id'], run_id)
        with pytest.raises(WorkConflict, match='correction_context_required'):
            await checked_context(service, task['id'], run_id, None)
        for value in (' ', 'x' * 4097, '中' * 1366, '\ud800', 'bad\0text'):
            with pytest.raises(InvalidWork):
                await request(fixture, corrections, task, instruction=value)
        with pytest.raises(InvalidWork):
            await request(fixture, corrections, task, expected_sequence=True)
        command = await request(fixture, corrections, task, instruction='x' * 4096)
        WorkCorrection.model_validate(command)
        with pytest.raises(ValidationError):
            RequestCorrection.model_validate(dict(runId=run_id, instruction='中' * 1366,
                                                   requestKey='key', expectedSequence=0))
        with pytest.raises(ValidationError):
            RequestCorrection.model_validate(dict(runId=run_id, instruction='safe',
                                                   requestKey='key', expectedSequence=0, grant=True))
    asyncio.run(check())


def test_command_idempotency_sequence_race_and_eight_instruction_limit(fixture):
    async def check():
        service, task, corrections, _, _ = await setup(fixture)
        key = str(uuid4())
        first, duplicate = await asyncio.gather(*(request(fixture, corrections, task, request_key=key)
                                                  for _ in range(2)))
        assert first == duplicate and first['sequence'] == 1
        with pytest.raises(WorkConflict, match='correction_content_changed'):
            await request(fixture, corrections, task, request_key=key, instruction='changed')
        with pytest.raises(WorkConflict, match='correction_content_changed'):
            await request(fixture, corrections, task, request_key=key, expected_sequence=1)
        outcomes = await asyncio.gather(*(request(fixture, corrections, task, expected_sequence=1)
                                         for _ in range(2)), return_exceptions=True)
        assert sum(isinstance(value, dict) for value in outcomes) == 1
        assert sum(isinstance(value, WorkConflict) for value in outcomes) == 1
        for sequence in range(2, 8):
            await request(fixture, corrections, task, expected_sequence=sequence, instruction='x' * 4096)
        with pytest.raises(WorkConflict, match='correction_limit'):
            await request(fixture, corrections, task, expected_sequence=8)
        context = await corrections.freeze(task['id'], task['runs'][0]['id'], 'full-context')
        assert len(context['corrections']) == 8
        assert context == await corrections.read(task['id'], task['runs'][0]['id'], context['id'])
        snapshot = await service.snapshot(fixture['token'], task['id'])
        assert snapshot['usage'] == {'tokenLimit': 100, 'reservedTokens': 0, 'spentTokens': 0}
    asyncio.run(check())


def test_same_request_key_is_independent_across_tasks(fixture):
    async def check():
        service, first_task, corrections, _, _ = await setup(fixture)
        second_task = await new(fixture, service)
        await corrections.enable(second_task['id'], second_task['runs'][0]['id'])
        key = str(uuid4())
        commands = await asyncio.gather(*(request(fixture, corrections, task, request_key=key)
                                           for task in (first_task, second_task)))
        assert commands[0]['id'] != commands[1]['id']
        for task, command in zip((first_task, second_task), commands):
            assert command['taskId'] == task['id'] and command['sequence'] == 1
            assert command == await request(fixture, corrections, task, request_key=key)
            with pytest.raises(WorkConflict, match='correction_content_changed'):
                await request(fixture, corrections, task, request_key=key, instruction='replacement')
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute('SELECT count(*) FROM work_corrections WHERE request_key=%s',
                              (key,)).fetchone() == (2,)
    asyncio.run(check())


@pytest.mark.parametrize('character', ['"', '\x01'], ids=['double-quotes', 'six-byte-escapes'])
def test_eight_maximum_escaped_instructions_can_freeze_and_replay(fixture, character):
    async def check():
        service, task, corrections, fence, _ = await setup(fixture)
        instruction = character * 4096
        commands = []
        for sequence in range(8):
            key = str(uuid4())
            command = await request(fixture, corrections, task, instruction=instruction,
                                    expected_sequence=sequence, request_key=key)
            assert command == await request(fixture, corrections, task, instruction=instruction,
                                            expected_sequence=sequence, request_key=key)
            commands.append(command)
        frozen = await corrections.freeze(task['id'], fence.run_id, 'escaped-maximum')
        assert frozen['corrections'] == [{'id': command['id'], 'instruction': instruction}
                                         for command in commands]
        assert frozen == await corrections.freeze(task['id'], fence.run_id, 'escaped-maximum')
        assert frozen == await corrections.read(task['id'], fence.run_id, frozen['id'])
        assert frozen == await checked_context(service, task['id'], fence.run_id, frozen['id'])
        with psycopg.connect(fixture['dsn']) as db:
            size = db.execute('SELECT octet_length(corrections::text) FROM work_correction_contexts '
                              'WHERE id=%s', (frozen['id'],)).fetchone()[0]
            assert 65536 < size <= 262144
    asyncio.run(check())


@pytest.mark.parametrize('close', ['cancel', 'revoke'])
def test_close_rejects_new_corrections_but_preserves_original_command_ack(fixture, close):
    async def check():
        service, task, corrections, _, original = await setup(fixture)
        key = str(uuid4())
        outcomes = await asyncio.gather(request(fixture, corrections, task, request_key=key),
            getattr(service, close)(fixture['token'], task['id']), return_exceptions=True)
        command = outcomes[0]
        assert isinstance(command, (dict, WorkConflict))
        with pytest.raises(WorkConflict, match='admission_closed'):
            await request(fixture, corrections, task, expected_sequence=int(isinstance(command, dict)))
        if isinstance(command, dict):
            assert command == await request(fixture, corrections, task, request_key=key)
        assert original == await corrections.freeze(task['id'], task['runs'][0]['id'], 'initial-segment')
        assert original == await corrections.read(task['id'], task['runs'][0]['id'], original['id'])
    asyncio.run(check())


def test_frozen_context_replay_scope_and_integrity(fixture):
    async def check():
        service, task, corrections, fence, original = await setup(fixture)
        command = await request(fixture, corrections, task)
        assert await corrections.freeze(task['id'], fence.run_id, 'initial-segment') == original
        current = await corrections.freeze(task['id'], fence.run_id, 'corrected-segment')
        assert current['corrections'] == [{'id': command['id'], 'instruction': command['instruction']}]
        assert current['generation'] > original['generation']
        with pytest.raises(CorrectionsChanged):
            await checked_context(service, task['id'], fence.run_id, original['id'])
        for bad in ('unknown-context', '', {'id': current['id']}):
            with pytest.raises(WorkConflict) as caught:
                await checked_context(service, task['id'], fence.run_id, bad)
            assert not isinstance(caught.value, CorrectionsChanged)
        other = await new(fixture, service)
        await corrections.enable(other['id'], other['runs'][0]['id'])
        with pytest.raises(WorkConflict, match='correction_context_invalid'):
            await corrections.read(other['id'], other['runs'][0]['id'], current['id'])
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('UPDATE work_correction_contexts SET corrections=%s WHERE id=%s',
                       (Jsonb([{'id': command['id'], 'instruction': 'tampered'}]), current['id']))
        with pytest.raises(WorkConflict, match='correction_context_corrupt') as caught:
            await corrections.read(task['id'], fence.run_id, current['id'])
        assert not isinstance(caught.value, CorrectionsChanged)
    asyncio.run(check())


def test_correction_supersedes_only_never_admitted_and_cannot_refresh_old_approval(fixture):
    async def check():
        service, task, corrections, fence, original = await setup(fixture)
        identity = await propose(service, task, fence, original, requires_approval=True)
        snapshot = await service.snapshot(fixture['token'], task['id'])
        intent_digest = snapshot['actions'][0]['intentDigest']
        await service.decide(fixture['token'], identity, intent_digest=intent_digest, approved=True)
        denied = await propose(service, task, fence, original, action_key='denied', requires_approval=True)
        await service.decide(fixture['token'], denied, intent_digest=intent_digest, approved=False)
        command = await request(fixture, corrections, task)
        snapshot = await service.snapshot(fixture['token'], task['id']); WorkSnapshot.model_validate(snapshot)
        actions = {a['id']: a for a in snapshot['actions']}
        assert (actions[identity]['status'], actions[identity]['decision']) == ('superseded', 'approved')
        assert (actions[denied]['status'], actions[denied]['decision']) == ('proposed', 'denied')
        assert actions[identity]['actualTokens'] is None and actions[identity]['evidence'] is None
        with pytest.raises(WorkConflict, match='approval_stale'):
            await service.decide(fixture['token'], identity, intent_digest=intent_digest, approved=True)
        with pytest.raises(CorrectionsChanged):
            await service.admit(identity, fence=fence)
        with pytest.raises(CorrectionsChanged):
            await propose(service, task, fence, original, action_key='late-old-prepare')
        current = await corrections.freeze(task['id'], fence.run_id, 'new-segment')
        with pytest.raises(WorkConflict, match='action_context_changed'):
            await propose(service, task, fence, current, requires_approval=True)
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute('SELECT authority_generation,superseded_by FROM work_actions WHERE id=%s',
                              (identity,)).fetchone() == (original['generation'], command['id'])
        assert snapshot['usage']['reservedTokens'] == 0
    asyncio.run(check())


def test_admission_and_correction_race_has_one_serialized_outcome(fixture):
    async def check():
        service, task, corrections, fence, context = await setup(fixture)
        identity = await propose(service, task, fence, context)
        admission, command = await asyncio.gather(service.admit(identity, fence=fence),
            request(fixture, corrections, task), return_exceptions=True)
        assert isinstance(command, dict)
        snapshot = await service.snapshot(fixture['token'], task['id'])
        action = snapshot['actions'][0]
        if admission is True:
            assert action['status'] == 'admitted' and snapshot['usage']['reservedTokens'] == 6
            assert await service.admit(identity, fence=fence) is False
        else:
            assert isinstance(admission, CorrectionsChanged)
            assert action['status'] == 'superseded' and snapshot['usage']['reservedTokens'] == 0
        assert action['actualTokens'] is None and action['evidence'] is None
    asyncio.run(check())


def test_unknown_and_applied_history_survive_correction_without_refund_or_reauthorization(fixture):
    async def check():
        service, task, corrections, fence, original = await setup(fixture)
        identity = await propose(service, task, fence, original)
        assert await service.admit(identity, fence=fence)
        await service.uncertain(identity)
        await request(fixture, corrections, task)
        assert await propose(service, task, fence, original) == identity
        assert await service.admit(identity, fence=fence) is False
        snapshot = await service.snapshot(fixture['token'], task['id'])
        assert snapshot['actions'][0]['status'] == 'unknown'
        assert snapshot['usage']['reservedTokens'] == 6 and snapshot['usage']['spentTokens'] == 0
        await service.resolve(identity, applied=True, actual_tokens=4, evidence=evidence())
        await service.cancel(fixture['token'], task['id'])
        assert await propose(service, task, fence, original) == identity
        snapshot = await service.snapshot(fixture['token'], task['id'])
        assert snapshot['actions'][0]['status'] == 'applied' and snapshot['usage']['spentTokens'] == 4
    asyncio.run(check())


async def publishing_setup(fixture, tmp_path):
    service = file_service(fixture, tmp_path)
    task, fence = await task_and_claim(fixture, service)
    corrections = CorrectionStore(service)
    await corrections.enable(task['id'], fence.run_id)
    context = await corrections.freeze(task['id'], fence.run_id, 'publication')
    return service, task, corrections, fence, context


@pytest.mark.parametrize('gate', ['before', 'after_blob'])
def test_both_publication_gates_reject_new_instruction(fixture, tmp_path, gate):
    async def check():
        service, task, corrections, fence, old = await publishing_setup(fixture, tmp_path)
        if gate == 'before':
            await request(fixture, corrections, task)
        else:
            original_put = service.files.put
            def interrupted(data):
                descriptor = original_put(data)
                asyncio.run(request(fixture, corrections, task))
                return descriptor
            service.files.put = interrupted
        with pytest.raises(CorrectionsChanged):
            await publish(fixture, service, task, fence, correction_context=old['id'])
        snapshot = await service.snapshot(fixture['token'], task['id'])
        assert snapshot['status'] == 'open' and snapshot['artifacts'] == []
        assert not any(event['kind'] == 'task.completed' for event in snapshot['events'])
        assert bool(list(tmp_path.iterdir())) == (gate == 'after_blob')
    asyncio.run(check())


def test_superseded_publication_and_exact_context_ack_after_completion(fixture, tmp_path):
    async def check():
        service, task, corrections, fence, old = await publishing_setup(fixture, tmp_path)
        identity = await propose(service, task, fence, old)
        await request(fixture, corrections, task)
        current = await corrections.freeze(task['id'], fence.run_id, 'corrected-publication')
        complete = await publish(fixture, service, task, fence, correction_context=current['id'])
        assert complete['status'] == 'completed'
        assert complete['actions'][0]['id'] == identity and complete['actions'][0]['status'] == 'superseded'
        assert complete['usage']['spentTokens'] == complete['usage']['reservedTokens'] == 0
        event = next(event for event in complete['events'] if event['kind'] == 'task.completed')
        assert event['payload']['correctionContext'] == current['id']
        assert await publish(fixture, service, task, fence, correction_context=current['id']) == complete
        assert await corrections.read(task['id'], fence.run_id, current['id']) == current
        with pytest.raises(WorkConflict, match='completion_content_changed'):
            await publish(fixture, service, task, fence, correction_context=old['id'])
        with pytest.raises(WorkConflict, match='correction_context_required'):
            await publish(fixture, service, task, fence)
    asyncio.run(check())


@pytest.mark.parametrize('state', ['unknown', 'denied', 'forged_superseded', 'forged_denied'])
def test_unresolved_or_previously_admitted_actions_block_corrected_publication(fixture, tmp_path, state):
    async def check():
        service, task, corrections, fence, old = await publishing_setup(fixture, tmp_path)
        identity = await propose(service, task, fence, old, requires_approval=(state in ('denied', 'forged_denied')))
        if state in ('unknown', 'forged_superseded'):
            await service.admit(identity, fence=fence)
            await service.uncertain(identity)
        else:
            snapshot = await service.snapshot(fixture['token'], task['id'])
            await service.decide(fixture['token'], identity,
                                 intent_digest=snapshot['actions'][0]['intentDigest'], approved=False)
        command = await request(fixture, corrections, task)
        if state == 'forged_superseded':
            with psycopg.connect(fixture['dsn']) as db:
                db.execute("UPDATE work_actions SET status='superseded',superseded_by=%s WHERE id=%s",
                           (command['id'], identity))
        elif state == 'forged_denied':
            with psycopg.connect(fixture['dsn']) as db:
                # A foreign-key pointer alone cannot fabricate the original supersession event.
                db.execute("UPDATE work_actions SET status='superseded',decision='approved',superseded_by=%s WHERE id=%s",
                           (command['id'], identity))
        current = await corrections.freeze(task['id'], fence.run_id, 'corrected-publication')
        with pytest.raises(WorkConflict, match='actions_unresolved'):
            await publish(fixture, service, task, fence, correction_context=current['id'])
        assert not list(tmp_path.iterdir())
        if state == 'unknown':
            assert (await service.snapshot(fixture['token'], task['id']))['usage']['reservedTokens'] == 6
    asyncio.run(check())


def test_late_profile_upgrade_is_rejected(fixture):
    async def check():
        service = store(fixture); task = await new(fixture, service)
        run_id = task['runs'][0]['id']
        fence = await service.claim(task['id'], run_id, 'legacy')
        await service.propose(task['id'], run_id, fence=fence, action_key='legacy', intent={},
                              reserved_tokens=0, requires_approval=False)
        with pytest.raises(WorkConflict, match='corrections_enable_too_late'):
            await CorrectionStore(service).enable(task['id'], run_id)
    asyncio.run(check())
