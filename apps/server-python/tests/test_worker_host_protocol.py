"""Differential validation against the retained, repository-pinned Zod protocol oracle."""
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import subprocess
from uuid import uuid4

import pytest

from openbot_server.worker_host_protocol import parse_frame
from test_worker_host_socket import hello, message, now


def test_retained_zod_worker_frames_are_the_compatibility_oracle():
    root = Path(os.environ.get("OPENBOT_PROTOCOL_ORACLE_ROOT", Path(__file__).resolve().parents[3]))
    node = shutil.which("node")
    if node is None or not (root / "packages/protocol/src/index.ts").is_file() or not (root / "node_modules/tsx").exists():
        pytest.skip("Requires repository-pinned Node/Zod oracle dependencies")
    run_id, request_id, offer_id = str(uuid4()), str(uuid4()), str(uuid4())
    values = [hello(), message("node.heartbeat", "node", activeRunIds=[run_id], sentAt=now()),
        message("run.accept", "node", runId=run_id, offerId=offer_id, acceptedAt=now()),
        message("run.reject", "node", runId=run_id, offerId=offer_id, reason="Declined", rejectedAt=now()),
        message("run.start_request", "node", runId=run_id, requestedAt=now()),
        message("run.progress", "node", runId=run_id, stage="  working  ", message="Synthetic progress", occurredAt=now()),
        message("run.frame", "node", runId=run_id, mediaType="image/png", base64="YWJjZGVmZ2hp", width=1.0, capturedAt=now()),
        message("approval.request", "node", runId=run_id, requestId=request_id, action="write", target="synthetic", summary="Review", risk="write", requestedAt=now()),
        message("run.completed", "node", runId=run_id, summary="Complete", artifacts=[{"name": "image", "mediaType": "image/png", "base64": "YWJjZGVmZ2hp"}], completedAt=now()),
        message("run.failed", "node", runId=run_id, error="Synthetic failure", failedAt=now())]
    corpus = deepcopy(values)
    for value in values:
        corpus.append({**value, "extra": 1})
        corpus.append({**value, "protocolVersion": "0.8.0"})
        for key in value:
            corpus.append({**value, key: None})
    for stamp in ("0000-01-01T00:00:00Z", "2000-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00+00:00", "2026-01-01T00:00Z"):
        corpus.append(hello(sentAt=stamp))
    for count in (True, 0, 1.0, 1.5, 16, 17):
        corpus.append(hello(maxConcurrentRuns=count))
    for text in ("\ufeff Worker \u3000", "😀" * 160, "😀" * 161, "", "  "):
        corpus.append(hello(name=text))
    for value in ("mailto:a@example.com", "foo:bar", "https://a b", "https:example.com", "https:\\example.com", "http://[bad]", "https://a:bad", "file:///tmp/a", " https://example.com "):
        completed = deepcopy(values[8])
        completed["artifacts"][0]["metadata"] = {"url": value}
        corpus.append(completed)
    corpus.append(hello(capabilityManifest=[{"id": "shell.execute", "version": 1, "providerId": "python", "constraints": {" x": 1, "x ": 2}}]))
    source = """import {nodeMessageSchema} from './packages/protocol/src/index.ts';
let raw='';for await (const chunk of process.stdin) raw+=chunk;
console.log(JSON.stringify(JSON.parse(raw).map(value=>{const r=nodeMessageSchema.safeParse(value);return r.success?{ok:true,value:r.data}:{ok:false};})));"""
    result = subprocess.run([node, "--import", "tsx", "--input-type=module", "-e", source], input=json.dumps(corpus),
                            text=True, capture_output=True, cwd=root, timeout=15, check=True)
    expected = json.loads(result.stdout)
    for index, (value, actual) in enumerate(zip(corpus, expected, strict=True)):
        try:
            parsed = {"ok": True, "value": parse_frame(value)}
        except (ValueError, TypeError, OverflowError):
            parsed = {"ok": False}
        assert parsed == actual, f"Protocol oracle mismatch at corpus item {index}: {value['type']}"
