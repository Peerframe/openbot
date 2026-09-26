# Native Task product qualification

[English](README.md) · [简体中文](README.zh-CN.md)

The 2026-09-25 case used real Owner HTTP, PostgreSQL, ProductWorkRuntime, and mTLS Temporal.
The model transport alone was synthetic. An explicit native scope authorized an uploaded CSV,
Owner-enabled memory, and one colleague. The root read the attachment/memory, delegated a real
child Task, consumed its persisted result, prepared an Owner-review proposal and published a
192-byte Markdown report. Both child and root received independent content review.

After the root completion transaction committed, the API/Worker was killed before Activity
acknowledgement. Restart recovered the identical result in the original Temporal Run. Ten model
phases occurred exactly once. Owner HTTP accepted the proposal with real Task/WorkRun provenance;
model use remained disabled. SQL checks required one child/proposal/completion and no fake
channel membership, legacy Run or work_sources row. Independent synthetic Web/FastMCP cases
also verified explicit scope, confirm approval, revocation and no resend; they are not represented
as Web/MCP participation in this Temporal journey.

## Offline regression

Use the repository's pinned Worker environment. This command does not create a network client,
register activities, read credentials, start Docker, or dispatch a model:

```sh
apps/server-python/.worker-venv/bin/python -B experiments/work-journey/product_native_replay.py
```

The two stored histories came from the actual successful parent/child executions. Only worker
identity and sticky queue names were replaced to remove host metadata. Normal queue names,
event IDs, Workflow commands, payloads and observations remain unchanged. `evidence.json` records
original/export hashes and the number of metadata replacements. The sanitized histories replayed
with the original Workflow IDs and the released SDK. They contain synthetic content only.

## Fresh mTLS qualification

Prerequisites are the existing pinned Worker environment, Node dependencies, Docker Compose,
OpenSSL and reviewed engine images described in the [journey reference](../README.md).
Provide a private JSON fixture with `dsn` and `ownerName` for an explicitly owned, canonically
migrated loopback database named `openbot_control_test_*`, with no Work Tasks. The fixture must
have mode0600 and the output must be new or empty. The same fixture format is already used by
the control tests; no real profile or provider account is required.

```sh
apps/server-python/.worker-venv/bin/python -B experiments/work-journey/product_native_probe.py \
  --repo . --fixture "$OPENBOT_NATIVE_FIXTURE" --output "$OPENBOT_NATIVE_OUTPUT"
```

The probe creates one owned engine with the existing resource overlay: Temporal 1536 MiB / 2 CPU,
PostgreSQL 512 MiB / 1 CPU and schema initialization 512 MiB / 1 CPU. It stops its API/Worker and
removes only its engine containers/volumes in finally. SQL evidence remains in the disposable
Control database; dispose of that fixture through its owning harness after review. Raw output
contains private synthetic configuration and TLS keys: publish only an explicit evidence
allowlist, never the entire output directory. A failed/unknown Action must not be retried by
resetting its database row; use a fresh owned fixture for another qualification.

`product_native_fixture.py`, `product_native_server.py` and `product_native_probe.py` retain the
successful scripted case, replacing packet-specific overlay loading and paths with explicit CLI
inputs/current checkout imports. Syntax/CLI checks and the sanitized-history replay were rerun
for this integration form. The original full HTTP/PG/mTLS evidence is retained in `evidence.json`;
this packaging step did not rerun the entire engine journey.

## Reuse and limits

See the existing [native capability review](../../../docs/research/python-native-task-capabilities.md).
The portable qualification adds no dependency, engine, business executor or runtime behavior.
It reuses the already reviewed OpenBot probes and exact SDK stack, preserving existing licenses
and Hermes learning attribution. No external source was copied. The changes affect test paths and
metadata export only; failure remains closed and unknown calls remain unresent.

This is execution/provenance/recovery evidence with a synthetic model, not a claim about live
model quality, external business effects, browser UI or Linux-host deployment. The controller
ran on macOS with Docker Linux Temporal/PostgreSQL. Stored histories establish compatibility
with these histories, not every future Workflow or SDK change.
