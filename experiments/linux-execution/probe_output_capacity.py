"""Real filesystem counterexamples only; this does not qualify Docker/runsc isolation."""

import argparse
import json
import os
import platform
from pathlib import Path
import subprocess
import sys
import tempfile

from sandbox import ActionSpec, Limits, prepare_action


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-only", action="store_true")
    args = parser.parse_args()
    if platform.system() != "Linux":
        raise SystemExit("this probe requires real Linux filesystem observations")
    with tempfile.TemporaryDirectory(prefix="openbot-capacity-") as temporary:
        root = Path(temporary)
        source = root / "input"
        output = root / "output"
        source.mkdir()
        output.mkdir()
        (source / "input.txt").write_bytes(b"synthetic input\n")
        prepared = prepare_action(ActionSpec(
            action_id="capacity-negative", action_epoch=1,
            image="example.invalid/probe@sha256:" + "a" * 64,
            command=("python3",), input_dir=source, output_dir=output,
            limits=Limits(output_mib=1),
        ), work_root=root)
        # A real child writes only two MiB; no sparse truncate, fake daemon or injected host facts.
        subprocess.run([sys.executable, "-c",
                        "import os,sys; f=open(sys.argv[1],'xb'); "
                        "f.write(b'x'*(2*1024*1024)); f.flush(); os.fsync(f.fileno()); f.close()",
                        str(output / "overflow.bin")], check=True, timeout=10)
        limit = prepared.spec.limits.output_mib * 1024 * 1024
        observed = (output / "overflow.bin").stat().st_size
        assert observed > limit
        report = {
            "evidence": "real-linux-filesystem-negative-only",
            "kernel": platform.release(), "machine": platform.machine(),
            "python": platform.python_version(), "uid": os.geteuid(),
            "sandbox_execution": False, "runsc_qualified": False,
            "counterexample": {"admitted_bytes": limit, "written_bytes": observed,
                               "child_exit": 0, "fsync": True},
        }
        if not args.baseline_only:
            from output_capacity import OutputCapacityRefused, verify_output_capacity

            refusals = {}
            for name, path in (("ordinary_directory", output), ("volatile_mount", Path("/tmp"))):
                try:
                    verify_output_capacity(path, limit)
                except OutputCapacityRefused as error:
                    refusals[name] = str(error)
                else:
                    raise AssertionError(f"unbounded/non-durable {name} was accepted")
            report["refusals"] = refusals
        print(json.dumps(report, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
