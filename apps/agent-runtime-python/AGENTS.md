# Python runtime contributor rules

This is the current harness source; `packages/harness` is a C2 target, not an existing package.
Start with the [core route](../../docs/REPOSITORY_MAP.md#python-core). `contracts.py` defines bounded
ports; `executor.py` composes ordinary execution; `temporal_agent.py` is optional Worker composition.
Keep ordinary import independent of Temporal and of control/database/provider implementations.

Authority, model and tool ports come from a trusted host. Call IDs are correlation only. Preserve
sticky refusal, byte ceilings, cancellation and correction adoption. Control owns facts, permission,
approval, root budget and publication; the runtime may not create another authority or recovery loop.
Do not collapse a bounded process lifetime into a replayable Activity or change Workflow names/data.

Use `scripts/bootstrap.sh`, then `scripts/check.sh` from this directory for the locked, synthetic
core suite. The map lists focused `-k` selectors and actual consumers. Optional Temporal integration
requires its separate Worker environment; base tests are not replay evidence. Keep dependencies and
lock/environment checks intact. No core move, wheel or new public API is implied by these rules.
