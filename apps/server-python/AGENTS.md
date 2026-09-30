# Python control contributor rules

This is the active product authority. `scripts/dev-python.ts` starts `scripts/serve.py` in explicit
product mode; direct `serve.py` stays read-only by default. See the
[control route](../../docs/REPOSITORY_MAP.md#control-and-persistence) and [README](README.md).

Keep identity, authorization, routing, approvals, root budgets, task/action facts, artifact publication
and audit here. Validate before effects; keep transactions bounded and conditional. Unknown effects
require authoritative lookup or remain unknown, never blind retry/refund. Temporal owns durable
continuation. Trusted factories run external work only in Activities, not Workflow replay.

Read public DTO/wire consumers before contract edits. Preserve SQL history in `packages/db/migrations`
and frozen oracle provenance. Use disposable database fixtures, never the user's configured data.
The base `.venv` and `.worker-venv` have distinct locked closures. `scripts/check.sh` delegates files
listed in `worker-tests.txt`; use the documented Worker interpreter and `test:control:python` for that
integration. An ignored/skipped Worker file is not verified. Do not reactivate the retired TS Server.
