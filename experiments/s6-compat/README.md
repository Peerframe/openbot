# S6 compatibility fixture

[English](README.md) · [简体中文](README.zh-CN.md)

This opt-in experiment calls the existing TypeScript Server stores, native runner and MCP service
with synthetic inputs. It creates an owned temporary PostgreSQL container and an authenticated
loopback MCP endpoint using the existing official-SDK example. No model account is needed.

From the repository root, with the repository-supported Node version and Docker running:

```sh
npm ci --ignore-scripts --no-audit
node experiments/s6-compat/run.mjs
```

The runner builds the required workspace packages, typechecks the dedicated tests, runs the six
probes, and removes its container. PostgreSQL uses the same pinned 17.11 image as the existing
headless acceptance harness. The command accepts no external database URL and does not load `.env`.
Product/model credentials are removed from the test child environment. Missing prerequisites or
failed assertions exit nonzero; the suite does not silently skip database cases. Temporary MCP
files contain only synthetic credentials and are removed after each test.

| Probe | What it establishes |
| --- | --- |
| `S6-GRANT` | Actual delegated child cannot use parent's MCP grant; explicit child grant works after reopening stores. |
| `S6-CANCEL` | Parent cancellation persists; reopened stores reject child tool use and late publication even without caller-provided ancestry. Already completed descendant reply survives. |
| `S6-APPROVAL` | Cancelled ancestry cannot approve a waiting child write; explicit caller abort clears the pending request without a dispatch. |
| `S6-MCP` | HTTP 401 blocks a call and catalog refresh without retry; local per-Bot revocation survives reopened stores and endpoint recovery. |
| `S6-CONFLICT` | Independent root Bots can run together; same-Bot/channel root claims serialize across database connections. |
| `S6-BUDGET-BASELINE` | Parent makes three web reads and child makes two; both complete under current per-Run budgets. Shared Task admission is a pending S6 requirement. |

Six passing probes include characterization of current per-Run budgeting, not shared Task budget
acceptance. Current architecture/asynchronous collaboration docs specify four web calls per Run;
the capability migration inventory instead calls the budget shared. The research records this
documentation mismatch. Once Task budget admission and its aggregate limit are selected, replace
this baseline assertion with that acceptance contract. Infrastructure or other failures are not
swallowed as expected failures.

The reload checks recreate database clients, store and service objects in the same test process.
They establish persisted record enforcement, not process-crash recovery. No Temporal worker,
Python control/Runtime integration, browser or file executor, OAuth refresh-token flow, uncertain
external effect reconciliation, or model-data migration is exercised. Shared resource coverage is
limited to current root claim serialization; no filesystem/browser lease claim follows.

The fixture calls service/store interfaces below authenticated product HTTP routes. Owner route
authentication and deployed cancellation notification are separate coverage. `S6-APPROVAL` explicitly
supplies the caller abort after persisted cancellation; production needs to connect that signal.

The [research and handoff](../../docs/research/s6-compatibility.md) records exact dependency/source
versions, the model field map and S2/S3/S4 dependencies. Tests live only in this experiment and are
not automatically included by `npm run check`; run both commands for handoff. An integrator can add
the opt-in command to a disposable Docker CI job once shared workflow changes are authorized.

No product default, migration history or S6 stage state is changed.
