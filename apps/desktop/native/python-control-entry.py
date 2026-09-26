"""Fixed Desktop parent-pipe lifetime around the existing Python product Server entry."""
import os
from pathlib import Path
import runpy
import signal
import sys
import threading
import time


def watch_parent():
    # The pipe closes on Desktop death. No renderer or network input reaches this channel.
    try:
        os.read(0, 64)
    finally:
        os.kill(os.getpid(), signal.SIGTERM)
        time.sleep(10)
        os.kill(os.getpid(), signal.SIGKILL)


if __name__ == "__main__":
    if len(sys.argv) != 1 or sys.platform != "darwin":
        raise SystemExit("Unsupported Desktop Python lifecycle invocation.")
    entry = Path(__file__).resolve().parents[1] / "apps/server-python/scripts/serve.py"
    threading.Thread(target=watch_parent, name="desktop-parent-pipe", daemon=True).start()
    runpy.run_path(str(entry), run_name="__main__")
