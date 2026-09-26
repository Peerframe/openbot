"""Trusted publication checks. A Runtime final answer never calls this method directly."""
import asyncio
import hashlib
from contextlib import nullcontext
from uuid import uuid4

from .database import StoreUnavailable
from .work_claims import check_fence
from .work_corrections import check_context
from .work_files import MAX_BYTES, artifact_media_type, artifact_name
from .work_values import InvalidWork, WorkConflict, canonical, receipt, text


def normalize(artifacts):
    if type(artifacts) not in (tuple,list) or len(artifacts) > 8:
        raise InvalidWork('artifact_limit')
    entries, keys = [], set()
    for value in artifacts:
        if type(value) is not dict or set(value) != {'key','name','mediaType','data'}:
            raise InvalidWork('invalid_artifact')
        key = text(value['key'],128)
        if key in keys or type(value['data']) is not bytes or len(value['data']) > MAX_BYTES:
            raise InvalidWork('invalid_artifact')
        keys.add(key)
        entries.append({'key':key,'name':artifact_name(value['name']),
                        'mediaType':artifact_media_type(value['mediaType']),
                        'sha256':hashlib.sha256(value['data']).hexdigest(),'sizeBytes':len(value['data'])})
    return entries


async def complete(store, task_id, run_id, *, fence, expected_revision, summary, artifacts, verification,
                   correction_context=None, publication=None):
    """The trusted verifier provides evidence of task quality; this store checks publication facts."""
    text(run_id,128); text(summary,16384); receipt(verification)
    if publication is not None and not callable(publication):
        raise InvalidWork('invalid_publication_hook')
    if type(expected_revision) is not int or expected_revision < 1:
        raise InvalidWork('invalid_revision')
    descriptors = normalize(artifacts)
    completion = {'taskId':task_id,'runId':run_id,'summary':summary,
                  'artifacts':descriptors,'verification':verification}
    if correction_context is not None:
        completion['correctionContext'] = correction_context
    _, digest = canonical(completion)
    if store.files is None:
        raise StoreUnavailable('work_files_unconfigured')

    async def ready(connection):
        task = await store._task(connection,task_id)
        if task['status'] == 'completed':
            await check_context(connection, task, run_id, correction_context, current=False)
            if task['completion_digest'] != digest:
                raise WorkConflict('completion_content_changed')
            return False
        store._active(task)
        await check_context(connection, task, run_id, correction_context)
        if task['revision'] != expected_revision:
            raise WorkConflict('task_revision_changed')
        cursor = await connection.execute('SELECT status FROM work_runs WHERE task_id=%s AND id=%s', (task_id,run_id))
        row = await cursor.fetchone()
        if row is None or row['status'] != 'running':
            raise WorkConflict('run_not_executing')
        await check_fence(connection,run_id,fence)
        # Superseding is only proof that this proposal never crossed admission. It is neither
        # an applied receipt nor a not-applied outcome; admitted/unknown still block publication.
        cursor = await connection.execute("SELECT 1 FROM work_actions a WHERE a.task_id=%s AND a.status<>'applied' "
            "AND NOT (a.status='superseded' AND a.decision<>'denied' AND a.actual_tokens IS NULL AND a.evidence IS NULL "
            'AND EXISTS (SELECT 1 FROM work_corrections c WHERE c.id=a.superseded_by AND c.task_id=a.task_id '
            'AND c.generation>a.authority_generation '
            "AND EXISTS (SELECT 1 FROM work_events ce WHERE ce.task_id=a.task_id AND ce.kind='correction.requested' "
            "AND ce.payload->>'correctionId'=c.id AND ce.payload->'supersededActionIds' ? a.id)) "
            "AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.task_id=a.task_id AND e.kind='action.admitted' "
            "AND e.payload->>'actionId'=a.id)) LIMIT 1", (task_id,))
        if await cursor.fetchone():
            raise WorkConflict('actions_unresolved')
        cursor = await connection.execute("SELECT 1 FROM work_runs WHERE task_id=%s AND id<>%s AND status IN ('queued','running') LIMIT 1", (task_id,run_id))
        if await cursor.fetchone():
            raise WorkConflict('runs_unfinished')
        return True

    # Check before writing files, then recheck under the publication lock. Immutable unreferenced
    # blobs are safe to retain on a failed commit; never delete a blob shared by another artifact.
    async with store._transaction(trusted=True) as connection:
        publishing = await ready(connection)
    for source, descriptor in zip(artifacts,descriptors):
        if publishing:
            stored = await asyncio.to_thread(store.files.put,source['data'])
            if stored != {key:descriptor[key] for key in ('sha256','sizeBytes')}:
                raise StoreUnavailable('work_file_integrity')
        else:
            await asyncio.to_thread(store.files.read,descriptor['sha256'],descriptor['sizeBytes'])
    async with store._transaction(trusted=True) as connection:
        if not await ready(connection):
            return await store._view(connection,task_id)
        async with publication(connection) if publication is not None else nullcontext():
            artifact_ids = []
            for descriptor in descriptors:
                # Reopen bytes after staging; a descriptor returned by a Worker is not evidence.
                await asyncio.to_thread(store.files.read,descriptor['sha256'],descriptor['sizeBytes'])
                identity = str(uuid4()); artifact_ids.append(identity)
                await connection.execute('INSERT INTO work_artifacts(id,task_id,run_id,artifact_key,name,media_type,sha256,size_bytes) '
                    'VALUES (%s,%s,%s,%s,%s,%s,%s,%s)', (identity,task_id,run_id,descriptor['key'],descriptor['name'],
                    descriptor['mediaType'],descriptor['sha256'],descriptor['sizeBytes']))
            await connection.execute("UPDATE work_runs SET status='completed' WHERE id=%s", (run_id,))
            await connection.execute("UPDATE work_tasks SET status='completed',authority_active=false,"
                'authority_generation=authority_generation+1,result_summary=%s,completion_digest=%s,completed_at=clock_timestamp() WHERE id=%s',
                (summary,digest,task_id))
            event = {'runId':run_id,'artifactIds':artifact_ids,'completionDigest':digest,'verification':verification}
            if correction_context is not None:
                event['correctionContext'] = correction_context
            await store._event(connection,task_id,'task.completed',event)
            from .work_sources import publish_source_message
            await publish_source_message(connection, task_id, summary)
            result = await store._view(connection,task_id)
        # Disk reads and audit writes may take time; expiration must still pass at publication.
        await check_fence(connection,run_id,fence)
        return result
