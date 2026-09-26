"""Actual retained publisher CLI -> Python reader compatibility, with owned synthetic keys.

Requires locked npm dependencies and built shared contracts, as supplied by the existing
oracle:build prerequisite. This test never imports the old Server or oracle implementation.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

import pytest

from openbot_server.employee_portability_publisher import EmployeePublisher


SIGN_OR_VERIFY = """
import {readFileSync} from 'node:fs';
import {EmployeePublisherKeyring} from './packages/employee-publisher/src/employee-publisher-keyring.ts';
import {buildEmployeeTemplate} from './packages/employee-publisher/src/employee-package.ts';
const value = JSON.parse(readFileSync(0, 'utf8'));
const ring = await EmployeePublisherKeyring.load(value.location);
const document = value.document ?? buildEmployeeTemplate({
  employee: {id: 'not-exported', name: 'Synthetic', role: 'Review public evidence', computerProfile: 'none'},
  details: {description: ''}, configuration: {executionProfile: 'none'},
  skills: [], memories: [], evolution: [],
  records: {runs: [], approvals: [], artifacts: [], decisions: []},
}, {
  generatedAt: '2026-09-25T00:00:00.000Z',
  packageId: '00000000-0000-4000-8000-000000000001',
}).document;
process.stdout.write(JSON.stringify(value.action === 'verify'
  ? ring.verify(value.envelope) : {document, envelope: ring.sign(document)}));
"""


def test_retained_cli_python_exact_dsse_and_key_lifecycle(tmp_path):
    root = Path(os.environ.get("OPENBOT_TS_SOURCE_ROOT", Path(__file__).resolve().parents[3]))
    node_binary = shutil.which("node")
    assert node_binary is not None, "Install the repository's reviewed Node runtime."
    assert (root / "packages/employee-publisher/src/employee-publisher-keyring.ts").is_file()
    assert (root / "packages/protocol/dist/index.js").is_file(), "Run npm run oracle:build first."
    # Explicit arguments supply every key path. Do not inherit .env, NODE_OPTIONS or credentials.
    environment = {name: os.environ[name] for name in (
        "PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
    ) if name in os.environ}

    def cli(command, *arguments, expected=0):
        result = subprocess.run(
            [node_binary, str(root / "scripts/employee-publisher-key.mjs"), command,
             *map(str, arguments)],
            cwd=root, env=environment, capture_output=True, text=True, timeout=15,
        )
        assert result.returncode == expected, (command, result.stderr)
        assert "PRIVATE KEY" not in result.stdout
        # The CLI appends a restart reminder after its structured result.
        return json.JSONDecoder().raw_decode(result.stdout)[0] if expected == 0 else None

    def sign_or_verify(value):
        result = subprocess.run(
            [node_binary, "--import", "tsx", "--input-type=module", "-e", SIGN_OR_VERIFY],
            cwd=root, env=environment, input=json.dumps(value), capture_output=True,
            text=True, timeout=15,
        )
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    def options(location):
        return ("--keyring", location["directory"], "--passphrase-file", location["passphraseFile"])

    # pytest retains tmp_path after a failure; remove the secret-bearing subtree ourselves.
    with tempfile.TemporaryDirectory(prefix="retained-publisher-", dir=tmp_path) as temporary:
        directory = Path(temporary)
        publisher = {"directory": str(directory / "publisher"),
                     "passphraseFile": str(directory / "publisher-secret/passphrase")}
        receiver = {"directory": str(directory / "receiver"),
                    "passphraseFile": str(directory / "receiver-secret/passphrase")}
        initial = cli("init", *options(publisher))
        cli("init", *options(receiver))
        produced = sign_or_verify({"location": publisher})
        python = EmployeePublisher.load(publisher["directory"], publisher["passphraseFile"])
        assert python.verify(produced["envelope"])["status"] == "verified"
        envelope = python.sign(produced["document"])
        assert envelope == produced["envelope"]
        assert sign_or_verify({
            "location": publisher, "action": "verify", "document": produced["document"],
            "envelope": envelope,
        })["status"] == "verified"

        public_key = directory / "public.pem"
        cli("export-public", *options(publisher), "--output", public_key)
        cli("trust", *options(receiver), "--public-key", public_key,
            "--expected-key-id", "ed25519:" + "0" * 64, expected=1)
        cli("trust", *options(receiver), "--public-key", public_key,
            "--expected-key-id", initial["activeKeyId"])
        assert EmployeePublisher.load(receiver["directory"], receiver["passphraseFile"]).verify(
            envelope)["status"] == "verified"
        cli("rotate", *options(publisher))
        assert EmployeePublisher.load(publisher["directory"], publisher["passphraseFile"]).verify(
            envelope)["status"] == "verified"
        cli("revoke", *options(publisher), "--key-id", initial["activeKeyId"])
        assert EmployeePublisher.load(publisher["directory"], publisher["passphraseFile"]).verify(
            envelope)["status"] == "rejected"

        wrong_passphrase = directory / "wrong-passphrase"
        wrong_passphrase.write_text("synthetic-wrong-passphrase")
        wrong_passphrase.chmod(0o600)
        with pytest.raises(ValueError, match="keyring could not be loaded"):
            EmployeePublisher.load(publisher["directory"], wrong_passphrase)
        if os.name != "nt":
            # POSIX permission checks do not establish a Windows ACL claim.
            Path(publisher["passphraseFile"]).chmod(0o644)
            with pytest.raises(ValueError, match="keyring could not be loaded"):
                EmployeePublisher.load(publisher["directory"], publisher["passphraseFile"])
    assert not any(tmp_path.iterdir())
