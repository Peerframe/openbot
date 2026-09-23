"""Persisted native Run ancestry; optional caller provenance never grants authority."""
from .runtime_ports import RuntimeDenied

_FIELDS = 'id,channel_id,bot_id,status,execution_profile,node_id,parent_run_id,root_run_id,delegated_by_bot_id'


async def active_chain(connection, run, *, target_update=False):
    chain, seen, identity = [], set(), run.id
    while identity:
        if identity in seen or len(chain) >= 3:
            raise RuntimeDenied('invalid_target')
        seen.add(identity)
        cursor = await connection.execute(f'SELECT {_FIELDS} FROM runs WHERE id=%s', (identity,))
        row = await cursor.fetchone()
        if row is None or row['channel_id'] != run.channelId or row['execution_profile'] != 'none' or row['node_id'] is not None:
            raise RuntimeDenied('invalid_target')
        if row['status'] != 'running':
            raise RuntimeDenied('conflict')
        chain.append(row)
        identity = row['parent_run_id']
    if not chain or chain[0]['bot_id'] != run.botId:
        raise RuntimeDenied('invalid_target')
    root = chain[-1]
    if root['root_run_id'] is not None or root['delegated_by_bot_id'] is not None:
        raise RuntimeDenied('invalid_target')
    for index, row in enumerate(chain[:-1]):
        if row['root_run_id'] != root['id'] or row['delegated_by_bot_id'] != chain[index+1]['bot_id']:
            raise RuntimeDenied('invalid_target')
    # Root-to-leaf matches cancellation. Write callers acquire UPDATE directly on their target;
    # a SHARE-to-UPDATE upgrade would deadlock two otherwise valid concurrent mutations.
    for row in reversed(chain):
        mode = 'UPDATE' if target_update and row['id'] == run.id else 'SHARE'
        cursor = await connection.execute(f'SELECT {_FIELDS} FROM runs WHERE id=%s FOR {mode}',(row['id'],))
        if await cursor.fetchone() != row:
            raise RuntimeDenied('conflict')
        cursor = await connection.execute('SELECT bot_id FROM channel_bots WHERE channel_id=%s AND bot_id=%s FOR SHARE',
                                          (row['channel_id'],row['bot_id']))
        if await cursor.fetchone() is None:
            raise RuntimeDenied('scope_revoked')
    return chain
