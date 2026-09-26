#!/usr/bin/env python3
"""Trusted host entry; -I imports the installed wheel, never a source or cwd override."""

import sys


def run() -> int:
    if sys.version_info < (3, 12):
        sys.stderr.write("openbot-agent-runtime: Python 3.12 or newer is required\n")
        return 2
    from openbot_agent_runtime.worker import main

    return main()


if __name__ == "__main__":
    raise SystemExit(run())
