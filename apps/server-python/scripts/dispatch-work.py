"""Operator-only, finite ingress. Reads one private configuration; never migrates schema."""
import argparse
import asyncio
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'src'), str(ROOT.parent / 'agent-runtime-python/src')]


def configuration(path):
    from openbot_server.work_engine_client import read_owned_file, validate_address, tls_config
    from openbot_server.work_values import text
    data = json.loads(read_owned_file(path, private=True, maximum=16384))
    required = {'database_url', 'temporal_address', 'namespace', 'queue', 'tls'}
    optional = {'limit', 'execution_timeout_seconds', 'item_timeout_seconds'}
    if type(data) is not dict or not required <= set(data) or set(data) - required - optional:
        raise ValueError('invalid_dispatch_configuration')
    text(data['database_url'], 4096); text(data['namespace'], 64); text(data['queue'], 256)
    validate_address(data['temporal_address']); tls_config(data['tls'])
    for name, default, maximum in [('limit',16,64), ('execution_timeout_seconds',3600,86400),
                                   ('item_timeout_seconds',10,30)]:
        value = data.get(name, default)
        if type(value) is not int or not 1 <= value <= maximum:
            raise ValueError('invalid_dispatch_limit')
        data[name] = value
    return data


async def dispatch(config, *, repair_closed=False):
    from openbot_server.work_engine_client import connect
    from openbot_server.work_store import PostgresWorkStore
    from openbot_server.work_handoff import HandoffStore
    from openbot_server.temporal_engine import TemporalEnginePort
    from openbot_server.work_dispatch_batch import dispatch_batch
    from openbot_server.work_worker import TYPE
    store = PostgresWorkStore(config['database_url'])
    async with asyncio.timeout(15):
        await store.verify_schema()
        client = await connect(config['temporal_address'], config['tls'], namespace=config['namespace'])
    if repair_closed:
        from openbot_server.work_repair_dispatch import repair_batch
        return await repair_batch(store, client, namespace=config['namespace'], queue=config['queue'],
            workflow_type=TYPE, limit=config['limit'], item_timeout_seconds=config['item_timeout_seconds'])
    return await dispatch_batch(HandoffStore(store), TemporalEnginePort(client),
        namespace=config['namespace'], queue=config['queue'], workflow_type=TYPE,
        limit=config['limit'], execution_timeout_seconds=config['execution_timeout_seconds'],
        item_timeout_seconds=config['item_timeout_seconds'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True, help='Absolute path to private operator JSON')
    parser.add_argument('--check', action='store_true', help='Validate local configuration without database/network calls')
    parser.add_argument('--repair-closed', action='store_true', help='Deliver existing lookup commands after the original workflow closes')
    args = parser.parse_args()
    try:
        config = configuration(args.config)
        if args.check:
            print(json.dumps({'status':'validated', 'networkCalls':0}))
            return 0
        results = asyncio.run(dispatch(config, repair_closed=args.repair_closed))
        print(json.dumps({'deliveries':results}))
        accepted = {'delivered', 'finished', 'waiting_original'} if args.repair_closed else {'acknowledged'}
        return 0 if all(r['status'] in accepted for r in results) else 2
    except Exception:
        # Configuration can contain a DSN and TLS key paths. No exception/body is logged.
        print(json.dumps({'status':'error', 'reason':'dispatch_failed'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
