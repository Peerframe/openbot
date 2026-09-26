# Product model configuration to durable Work Model Actions

Status: accepted thin adapter; 2026-09-25. No new dependency, Agent, loop, scheduler or SQL.

Reviewed existing reuse-ledger entries Python model services and Python model connections, their
research (`python-model-services.md`, `work-model-ports.md`), ProductModelPort,
ModelConnectionPort/ModelConnectionsService, ModelSettingsService, ModelReceipts,
execute_model_activity, work_sources, WorkRuntimeContext and accepted Activity/fence binding.
Retain reviewed exact Pydantic AI2.47.0 (77d5fce751ab8ab04bd5db4ed6acc1131a4baed6, MIT),
OpenAI3.17.0 (8c72a700d900fb2578227df564a54462abfe67f8, Apache-2.0),
Anthropic1.8.0 (4421d56a4dd23550c7097c9b7ab5668bd11e09c4, MIT),
HTTPX2 2.13.0 and Temporal1.33.0 (ab52fdde33ee8ed193402625bfdba25d240a762d, MIT).
Feature connection behavior remains original OpenBot MIT9cc73c9e78451e572f57d142d6b9caf62ccb78e2.
Official reviewed contracts: https://pydantic.dev/docs/ai/models/openai/ and
https://pydantic.dev/docs/ai/core-concepts/retries/. No upstream source is copied. The product port
is existing OpenBot code with one pre-send callback added, equivalent to ModelConnectionPort.

The first viable option is composition over these released/accepted ports. The exact local gap
is selecting credentials from the original queued product source and binding that configuration
to an existing durable Model Action. Reimplementing SDK messages, introducing a model cache or
another retry owner would duplicate reviewed authority and recovery behavior and is rejected.

## Decisions

- Public service: ProductWorkModel(store,client,scope,settings,connections,receipts,
  max_output_tokens=4096,reserve_policy=None,transport_factory=None). `call(context,request,*,
  admission_check=None,before_send=None)` receives root's accepted WorkRuntimeContext but rebinds
  the actual Activity and SQL Task/Run/source; that value itself grants no authority.
- Read only immutable work_sources→original runs.execution_profile/model_selection. Never read
  today's Bot model selection. Profile none resolves currently active explicit singleton settings;
  profile model requires an explicit queued selection. Missing selection is refused before calling
  resolve, which otherwise has a legacy fallback. Explicit legacy-kimi only uses service-supplied
  credentials; ambient provider keys are never consulted. Disabled/missing configs never fallback.
- Non-secret Action configuration is exactly source/revision/connectionId?/provider/model/baseUrl/
  protocol; keys, encrypted keys and key digests never enter it. Keys stay inside a per-call port.
- On retry, lookup the accepted Activity's existing operation key before resolving configuration.
  admitted/unknown/applied history uses its original immutable configuration and reservation with
  an always-refusing provider. It can recover an already received response after config rotation/
  disable, but can never issue a new request. Proposed actions must still match current config.
- Initial resolution, the root-supplied transactional admission_check seam, and actual transport
  before_send recheck fresh configuration and accepted Activity/Task/Run/source binding. Root's
  optional before_send checks consumed data/knowledge; recheck configuration afterward too so an
  awaited callback cannot silently rotate the credential snapshot. Do not hold locks across HTTP.
- Read one current SDK snapshot and its exact immutable start history per binding. Carry those
  control-derived facts into `assert_accepted_workflow_in_transaction` during admission; never
  call an independent-connection binding helper while already owning Task UPDATE. Recheck the
  same durable acceptance after the awaited root admission callback. No caller-provided facts
  or accepted identity overrides exist in the public interface.
- Default reservation conservatively uses bounded serialized input bytes plus maximum output
  tokens. An explicit trusted pure policy may replace this estimate within existing token limits;
  it cannot reserve less than the output cap. Actual reported usage remains existing receipt truth.
- No per-Run state or current-configuration cache. SDK clients are per invocation and always closed.

Root owns the compatible execute_model_activity(configuration=...,admission_check=...) extension,
strict configuration allowlist, same-transaction store.admit hook and all Workflow/HTTP wiring.
The admitted historical response is an observation, not permission for another model step or Task
completion. Root's Runtime guards and next-call fresh configuration checks remain required.

Acceptance uses the dedicated synthetic PostgreSQL fixture, actual Owner settings/connection
services and released SDKs with synthetic HTTP transports. Test queued-selection stability,
none/model protocol distinction, missing/disabled/rotated configuration at admission and send,
current binding, no secret provenance, receipt recovery after configuration changes, unknown
never resent, and explicit callback/byte/token bounds. No live provider or credentials are used.
The fixture writes actual HandoffStore reserve/acknowledge records; only SDK Activity info and
the immutable engine history lookup are synthetic. The full read-only SQL binding gates run.
Live Temporal scheduling remains root's integration responsibility.
