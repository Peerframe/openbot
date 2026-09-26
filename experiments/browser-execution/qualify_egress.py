"""Bounded actual Squid check in an owned Docker network-none fixture; never a host installer."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid

from egress_policy import compile_egress_policy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-image", required=True, help="Locally built immutable sha256 image ID")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if re.fullmatch(r"sha256:[a-f0-9]{64}", args.fixture_image) is None:
        parser.error("exact local fixture image sha256 ID required")
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    output = args.output.resolve()
    source = Path(__file__).resolve().parent
    policy = {"listen_address": "10.77.0.1", "listen_port": 3128, "client_address": "10.77.0.2",
              "origins": [{"scheme": "http", "host": host, "port": 18080} for host in
                          ("alpha.example", "private.example", "metadata.example", "control.example",
                           "ipv6.example", "private6.example")]
              + [{"scheme": "https", "host": "beta.example", "port": 18443}],
              "forbidden_networks": ["93.184.216.35/32"]}
    name = "openbot-squid-egress-" + uuid.uuid4().hex[:12]
    created = False
    with tempfile.TemporaryDirectory(prefix="openbot-egress-input-") as directory:
        inputs = Path(directory)
        (inputs / "squid.conf").write_text(compile_egress_policy(policy))
        shutil.copyfile(source / "egress_probe.mjs", inputs / "egress_probe.mjs")
        # Squid's unprivileged worker must be able to read the synthetic policy.
        inputs.chmod(0o755)
        for file in inputs.iterdir():
            file.chmod(0o644)
        command = ["docker", "create", "--platform=linux/amd64", "--pull=never", "--name", name,
                   "--network=none", "--cpus=1", "--memory=384m", "--memory-swap=384m", "--pids-limit=64",
                   "--security-opt=no-new-privileges", "--cap-add=NET_ADMIN", "--restart=no",
                   "--sysctl=net.ipv6.conf.all.disable_ipv6=0", "--sysctl=net.ipv6.conf.lo.disable_ipv6=0",
                   "--env=OPENBOT_EGRESS_FIXTURE=network-none-v1",
                   "--mount", f"type=bind,src={inputs},dst=/input,readonly",
                   "--mount", f"type=bind,src={output},dst=/output",
                   args.fixture_image, "node", "/input/egress_probe.mjs"]
        try:
            subprocess.run(command, check=True, capture_output=True, timeout=30)
            created = True
            inspection = json.loads(subprocess.check_output(["docker", "inspect", name], timeout=15))[0]
            assert inspection["HostConfig"]["NetworkMode"] == "none"
            assert not inspection["HostConfig"]["Privileged"]
            with (output / "RUN.log").open("w") as stream:
                run = subprocess.run(["docker", "start", "--attach", name], stdout=stream,
                                     stderr=subprocess.STDOUT, timeout=150)
            if not (output / "GUEST_RESULT.json").is_file():
                raise RuntimeError("fixture did not produce a result; inspect RUN.log")
            # On native Linux the guest file belongs to root. The invoking user
            # writes its separate final receipt only after container cleanup.
            result = json.loads((output / "GUEST_RESULT.json").read_text())
            result.update({"fixtureImage": args.fixture_image, "containerExitCode": run.returncode})
            result["accepted"] = result["accepted"] and run.returncode == 0
        finally:
            if created:
                subprocess.run(["docker", "rm", "-f", name], check=True, capture_output=True, timeout=20)
        result["ownedContainerRemoved"] = True
        (output / "RESULT.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
        if not result["accepted"]:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
