"""Only adapts synthetic fixture configuration to the actual product operator command."""
import json
from pathlib import Path
import subprocess
import sys
import control

cfg = control.settings()
path = Path(cfg['directory']) / 'operator.json'
path.write_text(json.dumps(dict(database_url=cfg['dsn'], temporal_address=cfg['temporal_address'],
    namespace='default', queue=cfg['queue'], tls=cfg['engine_tls'], execution_timeout_seconds=240)))
path.chmod(0o600)
script = Path(__file__).resolve().parents[2] / 'apps/server-python/scripts/dispatch-work.py'
result = subprocess.run([sys.executable, '-I', str(script), '--config', str(path)],
                        capture_output=True, text=True, timeout=60)
print(result.stdout, end='', flush=True)
raise SystemExit(result.returncode)
