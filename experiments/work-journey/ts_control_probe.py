"""Own a real mTLS Temporal server for the TS control probe; no Python Work execution."""
import argparse
import asyncio
import json
from pathlib import Path
import signal
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from postgres_server import PostgresServer, ROOT


async def qualify(node):
    with tempfile.TemporaryDirectory(prefix='openbot-work-ts-') as directory:
        server = PostgresServer(directory, mtls=True)
        child = None
        try:
            server.start()
            await server.connect()
            receipt = Path(directory) / 'fixture.json'
            receipt.write_text(json.dumps(dict(address=server.address, tls=server.client_settings)))
            receipt.chmod(0o600)
            child = await asyncio.create_subprocess_exec(node, 'scripts/test-work-ts.ts', str(receipt), cwd=ROOT)
            try:
                # The aggregate suite includes media, channels, collaboration and schedules.
                # Individual HTTP/SQL/Activity deadlines remain unchanged.
                code = await asyncio.wait_for(child.wait(), 600)
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


async def main(node):
    task = asyncio.current_task()
    for event in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(event, task.cancel)
    await qualify(node)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True, help='Existing supported Node executable')
    options = parser.parse_args()
    asyncio.run(main(options.node))
