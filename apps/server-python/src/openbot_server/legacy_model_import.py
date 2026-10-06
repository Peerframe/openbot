"""Trusted startup-only, transactional import; never deletes or rewrites retained files/keys."""
import hashlib

from psycopg.types.json import Jsonb

from .authority import PostgresTransactions
from .control_errors import ControlError
from .model_connections import _audit, _guard, _LOCK_NAMESPACE
from .model_presets import model_provider_base_url
from .owner_preferences import current_preferences


@_guard
async def import_legacy_model(dsn, settings, connections):
    source_id = hashlib.sha256(str(settings.path).encode()).hexdigest()
    async with PostgresTransactions(dsn).transaction() as db:
        # Same count lock as connection creation; preference lock precedes connection publication.
        await db.execute('SELECT pg_advisory_xact_lock(%s,1)', (_LOCK_NAMESPACE,))
        if await (await db.execute('SELECT 1 FROM legacy_model_imports WHERE source_id=%s', (source_id,))).fetchone():
            return
        retained = settings._current()
        if retained is None: return
        preset = 'kimi' if retained['provider'] == 'moonshot' else retained['provider']
        url = connections.policy.endpoint(preset, model_provider_base_url(retained['provider'], retained.get('baseUrl')))
        protocol = connections.policy.preset(preset)['protocol']
        preferences = await current_preferences(db, update=True)
        count = (await (await db.execute('SELECT count(*) AS total FROM model_connections')).fetchone())['total']
        if count >= 32: raise ControlError(503, 'legacy_model_import_connection_limit')
        # A source receipt survives connection deletion: a restart cannot recreate revoked authority.
        identity = dict(id='migrated-'+source_id[:40], presetId=preset, baseUrl=url)
        encrypted = connections.store.cipher.encrypt(retained['apiKey'], identity)
        enabled = bool(retained['agentEnabled'] and retained['agentEnabledAt'])
        await db.execute('INSERT INTO model_connections(id,name,preset_id,base_url,protocol,encrypted_api_key,enabled,default_model) '
            'VALUES(%s,%s,%s,%s,%s,%s,%s,%s)', (identity['id'], 'Migrated '+preset, preset, url, protocol, encrypted, enabled, retained['model']))
        await db.execute('INSERT INTO legacy_model_imports(source_id,legacy_revision,connection_id) VALUES(%s,%s,%s)',
            (source_id, retained['revision'], identity['id']))
        if enabled and preferences['defaultModel'] is None:
            if preferences['revision'] == 2147483647: raise ControlError(409, 'owner_preferences_revision_exhausted')
            await db.execute("UPDATE owner_preferences SET default_model=%s,revision=revision+1,updated_at=clock_timestamp() WHERE owner_id='owner'",
                (Jsonb(dict(connectionId=identity['id'],modelId=retained['model'])),))
        await _audit(db, 'MODEL_CONNECTION_CREATED', dict(id=identity['id'],presetId=preset,revision=1,source='legacy_migration',legacyFilesRetained=True))


async def import_legacy_path(dsn, connections, *, path=None, key=None, directory=None):
    """No old credential dependency after import, and no new singleton key on a clean install."""
    from pathlib import Path
    import os
    from .model_settings import ModelSettingsService
    selected = Path(path) if path else Path(directory)/'settings.json'
    source_id = hashlib.sha256(str(selected).encode()).hexdigest()
    async with PostgresTransactions(dsn).transaction() as db:
        if await (await db.execute('SELECT 1 FROM legacy_model_imports WHERE source_id=%s', (source_id,))).fetchone():
            return
    if not os.path.lexists(selected): return
    if path:
        if key is None: raise ControlError(503, 'legacy_model_encryption_key_required')
        settings = ModelSettingsService.from_legacy(path, key)
    else:
        settings = ModelSettingsService(directory)
    await import_legacy_model(dsn, settings, connections)
