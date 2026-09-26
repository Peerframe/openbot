#!/usr/bin/env python3
"""Fixed, trusted entry point for the OpenBot Python worker process.

The Server owns how this process is launched. The one supported invocation is::

    <package>/.venv/bin/python -I -u <package>/scripts/run-worker.py

run from any unrelated working directory. Everything about it is deliberate:

* **``-I``** isolates the interpreter: ``PYTHONPATH`` and the user site directory
  are ignored and the script's own directory is *not* placed on ``sys.path``, so
  the working directory cannot inject a module.
* **``-u``** keeps the descriptor unbuffered, so a frame is on the wire as soon as
  it is written rather than sitting in a buffer when the parent reads.
* The only path this file adds is its own resolved package ``src`` directory, found
  from its own location rather than from the environment, a working directory or an
  argument. Nothing here reads a provider credential, an endpoint, a database URL
  or any other variable: the worker's only inputs are its two pipes.

The process is ordinary trusted code, not a sandbox.
"""

from __future__ import annotations

import os
import sys

_SRC_NAME = "src"
_REQUIRED_PYTHON = (3, 12)


def _bootstrap() -> int:
    if sys.version_info < _REQUIRED_PYTHON:
        sys.stderr.write("openbot-agent-runtime: Python 3.12 or newer is required\n")
        return 2
    script = os.path.realpath(__file__)
    source = os.path.join(os.path.dirname(os.path.dirname(script)), _SRC_NAME)
    if not os.path.isdir(source):
        sys.stderr.write("openbot-agent-runtime: package source directory not found\n")
        return 2
    if source not in sys.path:
        sys.path.insert(0, source)
    return run()


def run() -> int:
    from openbot_agent_runtime.worker import main

    return main()


if __name__ == "__main__":
    raise SystemExit(_bootstrap())
