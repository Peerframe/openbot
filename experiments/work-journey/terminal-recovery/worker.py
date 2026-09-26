"""Probe composition only: existing fixture callbacks inside real ProductWorkService."""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import sys

ROOT=Path(os.environ['OPENBOT_TERMINAL_REPO'])
sys.path[:0]=[str(ROOT/'apps/server-python/src'),
             str(ROOT/'apps/agent-runtime-python/src'),str(ROOT/'experiments/work-journey')]
# Load the product service before the reused journey helper adjusts sys.path.
from openbot_server.work_product_service import ProductWorkService
import product_approval_worker as fixture

cfg=json.loads(Path(os.environ['OPENBOT_WORK_JOURNEY_CONFIG']).read_text())

@asynccontextmanager
async def product_service(_old_client,store,**options):
    options.pop('namespace');options.pop('queue')
    original=store._transaction
    if cfg.get('pause_terminal_commit'):
        @asynccontextmanager
        async def transaction(*args,**kwargs):
            async with original(*args,**kwargs) as db:
                before=(await (await db.execute("SELECT count(*) AS n FROM work_events WHERE kind='run.engine_terminal'")).fetchone())['n']
                yield db
                after=(await (await db.execute("SELECT count(*) AS n FROM work_events WHERE kind='run.engine_terminal'")).fetchone())['n']
            # A post-commit measurement barrier only. No product mutation or authority.
            if after>before:
                Path(cfg['directory'],'terminal-committed').touch()
                await asyncio.Event().wait()
        store._transaction=transaction
    def compose(client,scope):
        fixture.reference._CLIENT=client
        fixture.reference._SCOPE=scope
        return options
    service=ProductWorkService(store,cfg['product_config'],compose=compose)
    await service.start()
    try:yield service
    finally:await service.close()

fixture.product_worker=product_service
asyncio.run(fixture.main())
