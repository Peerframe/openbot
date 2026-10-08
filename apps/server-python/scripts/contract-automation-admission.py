"""Exercise retained Work admission for one TS-created disposable schedule; no execution."""
import asyncio
import json
from pathlib import Path
import sys
from urllib.parse import urlparse

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from openbot_server.automation_store import PostgresAutomations
from openbot_server.owner_files import OwnerFiles
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_store import PostgresWorkStore

config_path = Path(sys.argv[1])
assert config_path.is_file() and config_path.stat().st_mode & 0o077 == 0
config = json.loads(config_path.read_text())
target = urlparse(config['dsn'])
assert target.hostname == '127.0.0.1' and target.path.startswith('/openbot_control_test_')
with psycopg.connect(config['dsn']) as db:
    db.execute("UPDATE automations SET next_run_at=now()-interval '2 days' WHERE id=%s", (config['scheduleId'],))

async def qualify():
    files = OwnerFiles(Path(config['objectRoot']))
    sources = WorkSourceAdmission(PostgresWorkStore(config['dsn'], files=LocalWorkFiles(Path(config['workRoot']))), token_limit=10000)
    stores = [PostgresAutomations(config['dsn'], files=files, work_sources=sources) for _ in range(4)]
    batches = await asyncio.gather(*(store.submit_due() for store in stores))
    assert sum(len(batch) for batch in batches) == 1
    with psycopg.connect(config['dsn']) as db:
        row = db.execute('SELECT last_run_id,last_outcome FROM automations WHERE id=%s', (config['scheduleId'],)).fetchone()
        assert row[1] == 'submitted'
        assert db.execute('SELECT count(*) FROM work_sources WHERE legacy_run_id=%s', (row[0],)).fetchone() == (1,)
        db.execute("UPDATE automations SET next_run_at=now()-interval '2 days' WHERE id=%s", (config['scheduleId'],))
    assert await stores[0].submit_due() == []
    with psycopg.connect(config['dsn']) as db:
        assert db.execute('SELECT last_outcome FROM automations WHERE id=%s', (config['scheduleId'],)).fetchone() == ('skipped_active',)

asyncio.run(qualify())
print('Four competing retained Python admission requests: one source/Work handoff; active occurrence skipped.')
