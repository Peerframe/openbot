# Python control selection port

[English](SELECTION_PORT.md) · [简体中文](SELECTION_PORT.zh-CN.md)

Status: implemented reference port; design recorded before implementation, 2026-09-24. This extends the accepted S5
offline module at `5d838b566a39afbeb31d42b6adcd62a17e55d4a0`. It does not register a product
service. Hermes Agent remains the inspiration for reviewed learning and provenance.

## Research and reuse

The existing [S5 research](../../docs/research/s5-memory-skills.md) and reuse-ledger reviews of
Owner memory and reviewed skill content remain applicable. GitHub/primary-documentation search
on 2026-09-24 checked Python Protocol type validation, fixed-release implementation/tests, and the
pinned Agent Skills format. No dependency, skill standard or lifecycle is replaced.

| Candidate | Pin and license | Review and choice |
| --- | --- | --- |
| Existing S5 module | `5d838b566a39afbeb31d42b6adcd62a17e55d4a0`, MIT | Reuse `retrieve`, `select_skill`, current review digests, scope and provenance. Its 16-case acceptance and held-out fixture are retained. |
| Agent Skills | `69ef37e9424c0a7ea9dd2293b559e43ec8176379`, Apache-2.0 code / CC-BY-4.0 docs | [Specification](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx) covers instructions; it does not supply Task-bound freshness or Server authority. Earlier source/test/issue review is unchanged. |
| Python standard library | CPython `v3.12.13`, PSF | [Protocol source](https://github.com/python/cpython/blob/v3.12.13/Lib/typing.py) and [documentation](https://docs.python.org/3.12/library/typing.html) support an explicit port plus frozen values. Runtime-checkable protocols check presence, not types; issue [#113320](https://github.com/python/cpython/issues/113320) also records introspection hazards. Use ordinary Protocol annotations with explicit input checks. The pinned test source was unavailable through the web reader; upstream tests were not run. |

The first viable option is a thin read adapter around the existing S5 module, not a second memory
store. The local gap is a bounded, immutable selection result and a fresh revalidation call bound
to the trusted target Task/Run. No upstream source is copied or substantially adapted; no added
license notice or dependency is required.

## Contract

The asynchronous `SelectionPort` exposes `select(task_id, run_id, query)` and
`revalidate(task_id, run_id, query, receipt)`. A control-supplied asynchronous loader resolves
current Task/Run identity, revision, active status and scope **on every call**. Constructing a port
does not call the loader. No runtime-supplied scope, role or grants are accepted.

The result carries immutable memory content and skill Markdown, plus a receipt binding:

- target Task/Run/revision and Owner/Bot/workspace/task-kind scope;
- query SHA-256;
- memory ID/revision/content digest and Task/Run/Artifact/correction provenance;
- skill ID/version/assignment revision, content digest, exact reviewed envelope digest and provenance.

The memory revision is its version. The skill's envelope digest is the existing offline review
format; it is distinct from its SKILL.md content digest. A receipt is descriptive evidence, not
a permission token or proof that a model consumed the text. It contains digests and must remain
control-private if saved in a checkpoint; do not copy it to the content-free lifecycle audit.

Revalidation reloads current target state and reselects using the same bounded query. It returns
fresh content only if the entire receipt still matches. Suspension, revocation, deletion, memory
model-use disable, source corruption/unavailability, changed content/provenance/version/review,
task revision/scope or query invalidate reuse. Resume requires new references. Ranking changes can
also conservatively invalidate an old receipt; callers must explicitly assemble a fresh context.
An exception never authorizes reuse of an old result.

Memory opt-in and skill review remain separate: disabling model use removes the memory component
and invalidates a previously combined receipt; an independently verified skill may still be
selected afresh. Suspending/revoking a skill also blocks its derived memory, as in the accepted
fixture. Writers must increase revisions even across disable/re-enable; no observer can detect an
unrecorded intermediate transition.

The port returns up to four memories and one skill, within 32 KiB of serialized output. Original
512-byte query, 2000-byte memory, 12-KiB skill and 4096-byte source CSV bounds also apply.
The receipt is a typed in-process value, not a new HTTP or signed checkpoint format; arbitrary JSON
is rejected. `Selection.to_dict()` creates a detached projection for inspection or controlled storage.

The adapter reuses the original fixture's selection and eligibility rules. It validates the
selected source against the fixture's current completed-task facts and Artifact bytes. This is
one synthetic source resolver, not a product provenance API. Source verification must be implemented
under authoritative access checks when replacing the adapter. Content already returned cannot be
recalled; revalidation blocks its future use only when the caller enforces the gate.

## Read-only mainline contract review

Inspected `codex/architecture-migration@6f69be91185a08350ca52964c3f0543ef51f0020`:
`work_models.py` supplies independent Task/Run/Artifact projections; `work_routes.py` authenticates
Task snapshots/downloads; `work_completion.py` verifies authority/revision/fence and bytes.
Its completion signature still has no dedicated memory/skill reference argument.
Workspace/task-kind are absent from the work projection. The original S5 short handoff explicitly
retains offline-only acceptance. No mainline or unrelated dirty file is modified.

Main control integration must provide an authenticated target loader, real scoped source/record
reads with monotonic revisions, and a serialized knowledge recheck before context use and final
publication. A check followed by a later effect is not an atomic authorization boundary. The current
adapter remains a trusted single-process fixture; it adds no product hook, SQL, engine activity,
runtime tool, permission, global registry or default service. Real-model evaluation has no supplied
authorized configuration in this work package and is not run.

## Verification plan

Run the new port contract tests, including stale/deleted/disabled references, source corruption,
cross-Task/Run/scope/query reuse, exact reviewed versions, bounds, missing trusted context and
unchanged grants. Exercise existing held-out cases through the new selection API without changing
the answer key. Retain prior unaffected checks; run repository-required checks with cache/skip status
recorded. Hand back a focused local commit and this dependency list for independent acceptance.

## Calling and reproducing

The standalone module is importable from this experiment directory; it has no package installation.
The actual CLI example uses an asynchronous synthetic control loader and the unchanged held-out data:

```sh
python3.12 -B -m unittest discover -s experiments/s5-memory-skills -p 'test_selection_port.py' -v
python3.12 -B experiments/s5-memory-skills/selection_probe.py
```

For a Python control caller with this directory on its import path:

```python
from selection_port import OfflineSelectionPort, SelectionPort

port: SelectionPort = OfflineSelectionPort(existing_fixture_control, trusted_async_target_loader)
selected = await port.select(task_id, run_id, query)
current = await port.revalidate(task_id, run_id, query, selected.receipt)
# Use current.memories/current.skills as untrusted context only after the control gate.
```

The loader must return a `TaskBinding` with current authenticated scope and active status.
The product adapter and transaction ownership are still main-control integration work. Do not register
the fixture as a production service or infer workspace/task kind from arbitrary request text.

## Actual verification and handoff

Python 3.12.13 on macOS: 15 new asynchronous port tests passed. The CLI
`selection_probe.py` passed all three existing held-out cases through selected and revalidated
versions. It called the target loader on all ten selection/revalidation calls, wrote no selection
audit events, retained the same two simulated grants, and rejected the original receipt after
suspension, resume, terminal revocation and deletion. See the
[synthetic output](evidence/selection-port-result.json).

The original `study.py`, `probe.py`, training/held-out fixtures and 16-test acceptance remain unchanged.
The unchanged old unit suite and broad product suites were not rerun in this work package, per the
parallel-work instruction; their earlier evidence is retained. No real model configuration was
supplied or used. `npm run docs:check` passed for 405 Markdown files;
`node_modules/.bin/biome check experiments/s5-memory-skills` passed for the four supported JSON
files; `git diff --check` passed. Python behavior is covered by the focused tests above, not Biome.

Integration dependencies remain the authenticated target/source readers, monotonic lifecycle
revisions, formal product scope fields, and a serialized recheck in context assembly/publication.
This deliverable provides a callable interface and counterexamples, not those hooks or S5 completion.
