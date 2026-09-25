"""Immutable product-native model selection, without an invented channel or Run source.

The Server creation transaction is the sole snapshot writer. A profile describes an
allowed execution path; fresh SDK, Task, correction, fence and provider grants remain
mandatory in the existing product adapters. No historical Task is silently promoted.
"""
from copy import deepcopy

from psycopg.types.json import Jsonb

from .identity_inputs import _ECMASCRIPT_WHITESPACE
from .model_connections_inputs import ModelSelection
from .work_values import WorkConflict, canonical, text

_NATIVE_CAPABILITIES = frozenset(('model','report','result_review'))
_CHANNEL_CAPABILITIES = _NATIVE_CAPABILITIES | frozenset(('channel_reads','attachments','knowledge','plugins','web','collaboration'))
_COMMAND_CAPABILITIES = _NATIVE_CAPABILITIES | frozenset(('channel_reads','attachments','command'))
_BROWSER_CAPABILITIES = _NATIVE_CAPABILITIES | frozenset(('channel_reads','attachments','browser_capture'))


def _profile(task_id, bot_id, execution_profile, selection):
    text(task_id,128); text(bot_id,128)
    if execution_profile not in ('none','model'):
        raise WorkConflict('product_task_profile_required')
    if execution_profile=='none':
        if selection is not None: raise WorkConflict('product_task_profile_invalid')
    else:
        try:
            parsed = ModelSelection.model_validate(selection).model_dump()
            if parsed != selection: raise ValueError()
        except (ValueError,TypeError):
            raise WorkConflict('product_task_model_required') from None
        selection=parsed
    value=dict(kind='work_task_profile',version=1,taskId=task_id,botId=bot_id,
               executionProfile=execution_profile,modelSelection=selection)
    return value,canonical(value)[1]


class WorkTaskProfiles:
    def __init__(self, *, files=None):
        self.files=files

    def scope_lock(self, value):
        from .work_native_scope import scope_lock
        return scope_lock(self.files,value)

    async def capture_in_transaction(self, db, task_id, bot_id, *, scope=None):
        """Only the successful new native Task INSERT branch calls this trusted hook."""
        bot=await (await db.execute("SELECT computer_profile,configuration->'model' AS selection "
            'FROM bots WHERE id=%s FOR SHARE',(bot_id,))).fetchone()
        if bot is None: raise WorkConflict('product_task_bot_missing')
        selection=bot['selection'] if bot['computer_profile']=='model' else None
        _,digest=_profile(task_id,bot_id,bot['computer_profile'],selection)
        if await (await db.execute('SELECT 1 FROM work_sources WHERE task_id=%s',(task_id,))).fetchone():
            raise WorkConflict('product_source_ambiguous')
        await db.execute('INSERT INTO work_task_profiles(task_id,bot_id,execution_profile,model_selection,profile_digest) '
            'VALUES(%s,%s,%s,%s,%s)',(task_id,bot_id,bot['computer_profile'],Jsonb(selection) if selection else None,digest))
        from .work_native_scope import capture_scope
        await capture_scope(db,task_id,bot_id,scope,self.files)


async def resolve_product_source(db, task, bot_id, *, command_profiles=None, browser_profiles=None):
    """Caller owns the existing source-before-Task locks; this does not grant authority."""
    if task['bot_id'] != bot_id: raise WorkConflict('product_source_changed')
    mapping=await (await db.execute('SELECT legacy_run_id,channel_id,source_message_id FROM work_sources '
        'WHERE task_id=%s FOR SHARE',(task['id'],))).fetchone()
    native=await (await db.execute('SELECT task_id,bot_id,execution_profile,model_selection,profile_digest '
        'FROM work_task_profiles WHERE task_id=%s FOR SHARE',(task['id'],))).fetchone()
    command=await (await db.execute('SELECT 1 FROM work_command_profiles WHERE task_id=%s FOR SHARE',
        (task['id'],))).fetchone()
    browser=await (await db.execute('SELECT 1 FROM work_browser_profiles WHERE task_id=%s FOR SHARE',
        (task['id'],))).fetchone()
    if browser is not None and (native is not None or mapping is None or command is not None):
        raise WorkConflict('product_source_ambiguous')
    if command is not None and (native is not None or mapping is None):
        raise WorkConflict('product_source_ambiguous')
    if mapping is not None and native is not None:
        raise WorkConflict('product_source_ambiguous')
    if mapping is not None:
        origin=await (await db.execute('SELECT bot_id,channel_id,source_message_id,execution_profile,model_selection,node_id,'
            'left(instruction,32769) AS instruction '
            'FROM runs WHERE id=%s FOR SHARE',(mapping['legacy_run_id'],))).fetchone()
        message=await (await db.execute('SELECT channel_id FROM messages WHERE id=%s FOR SHARE',
            (mapping['source_message_id'],))).fetchone()
        if (not origin or not message or origin['bot_id']!=bot_id
                or origin['channel_id']!=mapping['channel_id'] or message['channel_id']!=mapping['channel_id']
                or origin['source_message_id']!=mapping['source_message_id'] or origin['node_id'] is not None
                or origin['instruction']!=task['objective']):
            raise WorkConflict('product_source_changed')
        if origin['execution_profile'] not in ('none','model','docker-linux'):
            raise WorkConflict('product_model_profile_required')
        member=await (await db.execute('SELECT 1 FROM channel_bots WHERE channel_id=%s AND bot_id=%s FOR SHARE',
            (mapping['channel_id'],bot_id))).fetchone()
        if not member: raise WorkConflict('product_model_scope_changed')
        snapshot = {}
        selection = origin['model_selection']
        if origin['execution_profile'] == 'docker-linux':
            if browser is not None:
                from .work_browser_profiles import BrowserProfiles
                if type(browser_profiles) is not BrowserProfiles:
                    raise WorkConflict('browser_profile_required')
                profile,digest = await browser_profiles.resolve_in_transaction(db,task)
                snapshot = dict(browser_profile_digest=digest)
            else:
                from .work_command_profiles import CommandProfiles
                if type(command_profiles) is not CommandProfiles:
                    raise WorkConflict('command_profile_required')
                profile,digest = await command_profiles.resolve_in_transaction(db,task)
                snapshot = dict(command_profile_digest=digest)
            selection = profile.modelSelection.model_dump()
        elif command is not None or browser is not None:
            raise WorkConflict('product_source_ambiguous')
        # Keep the original channel Model source keys stable; only the discriminator is new.
        return dict(source_kind='channel',**mapping,bot_id=bot_id,run_channel=origin['channel_id'],
            run_message=origin['source_message_id'],execution_profile=origin['execution_profile'],
            model_selection=selection,**snapshot)
    if native is None or native['bot_id']!=bot_id:
        raise WorkConflict('product_source_changed')
    _,digest=_profile(task['id'],bot_id,native['execution_profile'],native['model_selection'])
    if digest!=native['profile_digest']:
        raise WorkConflict('product_task_profile_changed')
    from .work_native_scope import read_scope
    return dict(source_kind='task',**native,native_scope=await read_scope(db,task['id'],bot_id))


def product_capabilities(source):
    """Trusted catalog selection only; capability declarations never grant access."""
    if type(source) is not dict or source.get('execution_profile') not in ('none','model','docker-linux'):
        raise WorkConflict('product_source_required')
    if source['execution_profile']=='docker-linux':
        is_browser='browser_profile_digest' in source
        if is_browser and 'command_profile_digest' in source:raise WorkConflict('product_source_ambiguous')
        digest=source.get('browser_profile_digest' if is_browser else 'command_profile_digest')
        if (source.get('source_kind')!='channel' or type(digest) is not str or len(digest)!=64
                or any(c not in '0123456789abcdef' for c in digest)):
            raise WorkConflict('command_profile_required')
        return _BROWSER_CAPABILITIES if is_browser else _COMMAND_CAPABILITIES
    if source.get('source_kind')=='task':
        from .work_native_scope import capabilities
        return _NATIVE_CAPABILITIES | capabilities(source)
    if source.get('source_kind')=='channel': return _CHANNEL_CAPABILITIES
    raise WorkConflict('product_source_required')


async def task_profile_prompt(db, context, *, binding, files=None):
    """Trusted initial projection after a real SDK/correction binding, without channel data."""
    source=await binding.check(db,context,require_fence=False)
    if source['source_kind']!='task': raise WorkConflict('native_task_source_required')
    row=await (await db.execute('SELECT t.created_at,b.id,left(b.name,65) AS name,left(b.role,161) AS role,'
        'left(b.description,2001) AS description,b.profile_revision FROM work_tasks t JOIN bots b ON b.id=t.bot_id '
        'WHERE t.id=%s FOR SHARE OF b',(context.task_id,))).fetchone()
    if (not row or row['id']!=context.bot_id or not row['name'].strip(_ECMASCRIPT_WHITESPACE)
            or len(row['name'])>64 or not row['role'].strip(_ECMASCRIPT_WHITESPACE)
            or len(row['role'])>160 or len(row['description'])>2000):
        raise WorkConflict('product_profile_invalid')
    result=dict(bot=dict(id=row['id'],name=row['name'],role=row['role'],description=row['description'],
        revision=row['profile_revision']),source=dict(kind='task',taskId=context.task_id,
        createdAt=row['created_at'].isoformat(),executionProfile=source['execution_profile'],
        modelSelection=deepcopy(source['model_selection']),profileSha256=source['profile_digest']),attachments=[])
    from .work_native_scope import capabilities, validate_attachments
    if 'attachments' in capabilities(source):
        validate_attachments(files,source['native_scope']['value'])
        result['attachments']=[files.owner_metadata(identity) for identity in source['native_scope']['value']['request']['attachmentIds']]
    canonical(result)
    return result
