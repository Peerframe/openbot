"""Own a real mTLS Temporal server for the TS control probe; no Python Work execution."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import signal
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from postgres_server import PostgresServer, ROOT


async def qualify(node, drain_only=False, ui_args=None, recovery_only=False):
    with tempfile.TemporaryDirectory(prefix='openbot-work-ts-') as directory:
        server = PostgresServer(directory, mtls=True)
        child = None
        try:
            server.start()
            await server.connect()
            receipt = Path(directory) / 'fixture.json'
            receipt.write_text(json.dumps(dict(address=server.address, tls=server.client_settings, python=sys.executable)))
            receipt.chmod(0o600)
            command = (['scripts/test-work-ts.ts', str(receipt), *(['--drain-only'] if drain_only else ['--recovery-only'] if recovery_only else [])]
                       if ui_args is None else ['scripts/ui-acceptance.ts', *ui_args])
            env = dict(os.environ)
            if ui_args is not None:
                env['OPENBOT_UI_TEMPORAL_FIXTURE'] = str(receipt)
            child = await asyncio.create_subprocess_exec(node, *command, cwd=ROOT, env=env)
            try:
                # The aggregate suite includes media, channels, collaboration and schedules.
                # Individual HTTP/SQL/Activity deadlines remain unchanged.
                code = await asyncio.wait_for(child.wait(), 1200)
            except (TimeoutError, asyncio.CancelledError):
                child.terminate()
                raise
            if code:
                raise RuntimeError('TypeScript control qualification failed')
        finally:
            if child is not None and child.returncode is None:
                child.terminate()
                try:
                    await asyncio.wait_for(child.wait(), 10)
                except TimeoutError:
                    child.kill()
                    await child.wait()
            server.close()


async def main(node, drain_only=False, ui_args=None, recovery_only=False):
    task = asyncio.current_task()
    for event in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(event, task.cancel)
    await qualify(node, drain_only, ui_args, recovery_only)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True, help='Existing supported Node executable')
    parser.add_argument('--drain-only', action='store_true', help='Only the existing SQL/engine ownership and drain gates')
    parser.add_argument('--ui', nargs=argparse.REMAINDER, help='Run the existing UI journey against the owned P4 engine')
    parser.add_argument('--recovery-only', action='store_true', help='Only the existing gates and actual process-death journey')
    options = parser.parse_args()
    asyncio.run(main(options.node, options.drain_only, options.ui, options.recovery_only))
