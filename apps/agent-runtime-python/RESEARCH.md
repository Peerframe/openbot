# Implementation research — Python execution unit

Scope: the bounded, SDK-backed Python unit under `apps/agent-runtime-python/`. Sections 1–7 are the
`TASK_002_PYTHON_RUNTIME.md` record, written before that implementation. Section 8 is the
`TASK_003_PYTHON_WORKER.md` record for the one-invocation process adapter, added alongside it. This
note records exactly which upstream releases and public APIs the code targets, what was verified by
running code rather than reading it, and which reviewed constraints are enforced where. **No upstream
source is copied.** Every claim below is either a pinned-commit source reference, installed-package
introspection, or a command that was actually executed on 2026-09-23.

## 1. Pinned dependency

| Item | Value |
| --- | --- |
| Package | `pydantic-ai-slim` |
| Version | `2.47.0` |
| Upstream commit for tag `v2.47.0` | `77d5fce751ab8ab04bd5db4ed6acc1131a4baed6` |
| License | MIT (`pydantic/pydantic-ai`) |
| Declared Python | the slim distribution supports 3.10+; this unit requires **3.12+** (see §6) |
| Installed into | package-local `.venv` only; full transitive closure in `requirements.lock` |

The version, license and tag commit match the revision already accepted in
`.workbuddy-handoff/BOUNDARY_RESEARCH.md` r2 (Codex independently confirmed the tag SHA, package
metadata and the `AbstractToolset` / usage-limit test source). This package adds one further direct
dependency, reviewed in §4.

## 2. Public API surface used (verified against the installed 2.47.0, not guessed)

Introspected with `inspect.signature` / `dataclasses.fields` against the installed distribution:

- `pydantic_ai.Agent.__init__(self, model, *, output_type=str, instructions=None, retries=None,
  toolsets=None, capabilities=None, ...)` and
  `Agent.run(self, user_prompt=None, *, message_history=None, usage_limits=None, retries=None,
  toolsets=None, ...)`.
- `pydantic_ai.models.Model` — ABC whose `__abstractmethods__ == {'request', 'model_name', 'system'}`,
  constructed as `Model(*, settings=None, profile=None)`. `Model.request(self, messages:
  list[ModelMessage], model_settings: ModelSettings | None, model_request_parameters:
  ModelRequestParameters) -> ModelResponse`.
- `pydantic_ai.toolsets.AbstractToolset` — ABC whose `__abstractmethods__ == {'id', 'call_tool',
  'get_tools'}`, with `get_tools(self, ctx) -> dict[str, ToolsetTool]` and
  `call_tool(self, name, tool_args: dict[str, Any], ctx, tool) -> Any`.
- `pydantic_ai.toolsets.abstract.ToolsetTool` fields: `toolset, tool_def, max_retries,
  args_validator, args_validator_func`.
- `pydantic_ai.tools.ToolDefinition` fields: `name, parameters_json_schema, description, ...,
  sequential, ...`.
- `pydantic_ai.tools.RunContext` fields include `tool_call_id`, `tool_name`, `run_step` — so the tool
  port can receive the SDK's per-call identifier. Its provenance is the **model-invocation path**:
  the tool-call entry of the model response, or the SDK's own generated stand-in (§3a.15). It is
  correlation data, so the unit never treats it as authority and never as proof that a side effect
  happened exactly once.
- `pydantic_ai.usage.UsageLimits(*, cost_limit=None, request_limit=50, tool_calls_limit=None, ...)`
  with `check_before_request` / `check_before_tool_call`.
- `pydantic_ai.tool_manager.ToolManager.parallel_execution_mode(mode)` — a public context manager
  over a run-scoped mode.
- `pydantic_ai.messages.ModelMessagesTypeAdapter` — `TypeAdapter(list[ModelMessage])`, used to measure
  the exact serialized byte size of the message payload handed to the model port.
- `pydantic_ai.Agent.instrument` property and `Agent._instrument_default = False`.

`Agent.__init__` in 2.47.0 has **no** `instrument=` keyword (it was removed/relocated), so the unit
sets the public `Agent.instrument` property to `False` explicitly after construction instead of
assuming a default. `_instrument_default` is already `False` and no environment variable switches it
on (grep for `getenv`/`environ` in `agent/__init__.py` and `_instrumentation.py` returns nothing), so
this is an explicit assertion of intent, not a behavioural change.

## 3. Behaviour verified by execution (probes, not readings)

Four probe scripts were run against the installed 2.47.0 with a scripted `Model` subclass and a probe
`AbstractToolset`. Results:

1. **Two-step journey.** Model step 1 returns a `ToolCallPart`; the toolset's `call_tool` is invoked
   with the parsed arguments and `ctx.tool_call_id == "c1"`; model step 2 sees 3 messages and returns a
   text part; `AgentRunResult(output='final')`. The loop is driven by the SDK.
2. **A tool-port exception is not swallowed.** With `retries=0`, `call_tool` raising a custom
   `Exception` subclass propagates out of `Agent.run(...)` unchanged (`PortError: port failed t1`) and
   the model port is **not** re-invoked (model steps: 1). Reading `pydantic_ai/tool_manager.py`
   confirms the mechanism: `_raw_execute` catches only `ToolFailed` and `ModelRetry` before re-raising
   everything else, and `_tool_execution.py`'s `_call_tool` additionally catches only
   `ToolRetryError`, `ToolFailedError` and `RunCancelled`. The two exceptions that *are* converted into
   model-visible observations are therefore `ToolFailed` (→ `ToolFailedError` → failed
   `ToolReturnPart`) and `ModelRetry` (→ `ToolRetryError` → `RetryPromptPart`). **The unit never raises
   either from a port failure**, which is what keeps a failed port from becoming an observation the
   model can route around.
3. **Strictly sequential tool execution is available as a public switch.**
   `with ToolManager.parallel_execution_mode('sequential')` serializes tool calls from one model
   response: with a 50 ms per-tool delay the probe observed `a` enter → `a` exit → `b` enter →
   `b` exit. The default `'parallel'` mode overlaps them (`a` enter → `b` enter → …), which is why the
   unit opts in explicitly rather than relying on a default.
4. **Cancellation and deadlines do not become success.**
   - Cancelling the `asyncio` task running the agent raises `CancelledError`.
   - `CancellationToken.cancel()` raises `pydantic_ai.exceptions.RunCancelled`.
   - A model port that *swallows* `CancelledError` and returns a response anyway still ends the run
     with `CancelledError`, not a result: the SDK re-delivers cancellation at its next await point.
   - `UsageLimits(request_limit=2)` raises `pydantic_ai.exceptions.UsageLimitExceeded` before the third
     request (2 model steps executed). This limit is an exception, not an observation.
5. **`Tool.from_schema` deliberately skips schema validation.** Its source builds the tool with
   `validator=SchemaValidator(schema=core_schema.any_schema())` and its docstring states "Schema
   validation of the arguments is skipped". `ToolsetTool.args_validator` is a pydantic-core
   `SchemaValidator` / `SchemaValidatorProt` (duck-typed on `validate_json` / `validate_python`), not a
   JSON Schema evaluator. A JSON Schema cannot be compiled into a pydantic core schema without an
   extra translation layer, so **argument validation is owned by this unit** (§4) and the SDK-side
   validator is an explicit pass-through.

## 3a. Further findings from implementing the unit

These were discovered by running the code, and they changed the implementation.

6. **The SDK writes a startup banner to stdout.** The first agent run in a fresh
   process prints a version banner and an "observability is off" notice to stdout.
   For a unit intended to be supervised as a process whose stdout carries its own
   channel, that is a defect, not cosmetics. `pydantic_ai.BANNER_ENABLED = False`
   is the documented switch (`pydantic_ai/__init__.py:414`,
   `_display.py:204-212`, which reads the flag dynamically and also honours
   `PYDANTIC_AI_NO_BANNER` — an environment variable this runtime deliberately does
   not rely on, since it does not own the host's environment). A fresh-interpreter
   test asserts a completed run writes nothing to stdout.

7. **An unknown tool name never reaches the toolset.** `ToolManager._resolve_tool`
   raises `ModelRetry` for a name that is not registered, and with `max_retries=0`
   `_check_max_retries` immediately raises
   `UnexpectedModelBehavior('Tool ... exceeded max retries count of 0')` **from**
   that `ModelRetry` (`tool_manager.py:305-308`). The originating causes survives as
   `__cause__`, which is how the unit reports `unknown_tool` instead of a vague
   model error, and how a model-invented name is proven never to invoke a tool port.

8. **At an equal threshold, the SDK's `UsageLimits` check fires before the runtime's
   own counter.** The SDK checks before the model port and before each tool call,
   while the runtime's counters run inside those boundaries. Passing `steps` and
   `tool_calls` straight into `UsageLimits` therefore replaced the runtime's
   `step_limit`/`tool_call_limit` reason with the SDK's generic one. The composed
   budget is consequently set exactly one step looser (`+1`), so the runtime counters
   are the enforcing layer and the SDK limit is a genuine backstop. A test pins the
   gap so it cannot be silently removed.

9. **`ModelMessagesTypeAdapter.dump_json` warns, it does not raise, for a near-miss
   history.** Serializing `[{"not": "a message"}]` emits pydantic serializer warnings
   and produces output, so a malformed history would only fail later inside the SDK
   with an unrelated-looking error. Input history is therefore validated with
   `validate_python` first and only then measured with `dump_json`.

10. **Effective instructions arrive on `ModelRequest.instructions`**, not inside a
    message part. This matters because it is how the runtime's applied corrections
    become observable to the Server adapter rather than being quietly folded into a
    prompt string.

11. **A relative `asyncio.timeout` around `agent.run` does not bound the whole
    execution.** The entry authority check, the corrections read and the final
    authority check are awaited boundaries *outside* `agent.run`. Probing with a
    deadline of `0.01 s` and an authority port that awaits a never-set
    `asyncio.Event` showed the run never resolving on its own deadline: only an outer
    `wait_for` ended it. The unit now puts the entire asynchronous body under one
    absolute monotonic `asyncio.timeout_at(guard.deadline_at)`; the instant is
    computed once, at guard construction, so preparation cannot reset it. Verified:
    hanging entry authority, hanging corrections and hanging exit authority all end in
    `deadline_exceeded`, and a slow corrections read that alone outlasts the deadline
    is refused rather than granted a fresh budget.

12. **A revocation during progress still allowed the model call.** `PortModel.request`
    checked authority, awaited `guard.progress(...)`, then called the model port with
    no further check. Probing with a progress callback that revokes showed the run
    eventually failing `authority_revoked` while the model had *already* been asked
    once. Progress is an awaited boundary, so authority is now re-checked after it and
    before any model-port work; the model call count stays `0` in that case. This
    mirrors the Server's own loop, which re-checks authority after its audit await
    (`apps/server/src/agent-runtime.ts:174,180`).

13. **Whitespace-only output was accepted.** A response whose only text part was
    `"   "` produced `RuntimeResult.text == "   "`. The Server refuses that
    (`!result.text.trim()` and `result.text.length > 8000`, then returns
    `result.text.trim()`, `apps/server/src/agent-runtime.ts:238-246`), so the unit now
    refuses blank text with `output_invalid` and returns trimmed text. A truly empty
    model response (an empty text part) is already rejected by the SDK itself as
    `UnexpectedModelBehavior`.

14. **Argument validation could surface a raw resolution error.** `jsonschema`'s
    `iter_errors` is lazy, so an unresolvable `$ref` only raised while violations were
    collected — as a bare `_WrappedReferencingError`, not a runtime refusal. Catalog now
    installs an explicit `referencing.Registry` whose only retrieval path raises
    `NoSuchResource`, so external `$ref`/`$dynamicRef` resolution is impossible by
    construction rather than by a library default, and any resolution failure is
    converted into `invalid_arguments`. Verified against the pinned builds: an
    `https://` reference and a `file://` reference to a *real, readable* file are both
    refused without the file ever being read, while an internal `#/$defs/...` reference
    still resolves. `referencing` is therefore promoted to a direct pin (§4).

15. **The tool-call identifier is model-invocation data, and the SDK synthesises it
    when the provider does not supply one.** `ToolCallPart.tool_call_id` is a dataclass
    field whose `default_factory` is `pydantic_ai._utils.generate_tool_call_id`, which
    returns `f'{TOOL_CALL_ID_PREFIX}{uuid.uuid4().hex}'` (prefix `pyd_ai_`) and
    documents only that the value "is unique". Probing the pinned build: two parts
    built without an identifier receive two *different* random values, and an explicit
    identifier is preserved verbatim. So the value reaching the tool port is either
    the provider's own tool-call entry or an SDK-generated random stand-in — in both
    cases it originates on the model-invocation path and is **not** minted or vouched
    for by this unit. Three consequences are now enforced rather than assumed:
    - **It is not authority.** `AuthorityPort` takes no arguments, so the guard cannot
      pass the identifier (or any call data) to the authority check. A test asserts
      every authority invocation during a real tool call is `((), {})`, and a
      never-seen identifier cannot restore revoked authority mid-response.
    - **It is not replay protection.** The `duplicate_tool_call` refusal only catches a
      literal repeat of one identifier within one run. The same name and arguments
      under a fresh identifier are admitted twice, and a test pins that honest limit
      rather than leaving the stronger claim implied.
    - **The unit does not synthesise identifiers.** An explicitly empty identifier is
      refused as `tool_call_unidentified`; filling it in would hide a malformed call
      behind generated correlation data.

## 4. Second direct dependency: `jsonschema`

Because the Server hands the unit *tool descriptors with JSON input schemas* and the SDK passes
arguments through unvalidated (§3.5), accepting the wrong arguments would mean forwarding junk to the
Server's tool authority. AGENTS.md prefers a released dependency over a narrow local implementation,
so the unit uses the reference implementation of the standard instead of a hand-rolled subset checker.

| Item | Value |
| --- | --- |
| Package | `jsonschema` |
| Version | `4.26.0` |
| Upstream commit for tag `v4.26.0` | `a7277432b0f7bcd0551f6e589d30457017125df4` |
| License | MIT (`python-jsonschema/jsonschema`) |
| Maintenance | not archived; last push `2026-09-21`; 4,986 stars; 56 open issues |
| Declared Python | `>=3.10` |
| Direct transitive deps | `attrs`, `jsonschema-specifications`, `referencing`, `rpds-py` |
| Extras used | none. The `format` extra is **not** installed, so `format` keywords are annotations only — which is the JSON Schema specification's own default behaviour without a format checker, and is recorded as a limitation in `TASK_002_RESULT.md`. |

Validation uses `Draft202012Validator`. Catalog construction rejects any descriptor whose schema is
not an object schema, so the validator is only ever applied to object-shaped argument dictionaries.

### 4a. Third direct dependency: `referencing`

`referencing` was already present as a `jsonschema` transitive dependency; it is promoted to an
explicit pin because the unit now imports it directly to own its `$ref` policy (§3a.14).

| Item | Value |
| --- | --- |
| Package | `referencing` |
| Version | `0.37.0` |
| Upstream commit for tag `v0.37.0` | `944ed5a20bc5125f2349156cbdc365daac0e67e6` |
| License | MIT (`python-jsonschema/referencing`) |
| Declared Python | `>=3.10` |
| Role here | supplies `Registry`, whose `retrieve` hook the unit sets to a function that raises `NoSuchResource` for every URI |

Promoting it changes no installed version — `requirements.lock` already froze `referencing==0.37.0` —
and `scripts/verify_environment.py` checks the new direct pin against the lock at the same version.

## 5. Reviewed constraints and where they are enforced

Checked against the actual Server sources on this branch (`ea2a693`, `apps/server/src/`):

- **Server keeps authority.** The unit proposes only. `Model.request` and
  `AbstractToolset.call_tool` are the only two places the run awaits outside the runtime, and the
  mandatory `authority` port is awaited before and after each of them and before a result is returned.
  No permissive fallback exists: an absent authority port fails closed, and a port that returns a
  non-awaitable is treated as invalid rather than as a pass.
- **Budget is Server-observable per model step.** The model port is called once per SDK model step and
  receives bounded messages, the tool descriptions actually offered, and the step index, so the Server
  adapter can persist per-step usage and re-check authority there. The unit's own step/tool counters
  and `UsageLimits` are secondary guards; the result deliberately carries no usage, no terminal state
  and no Server writes.
- **`8` steps / `16` tool calls** are the reviewed numbers from
  `apps/server/src/native-agent.ts` (`isStepCount(8)`, `budget.tools > 16`) and are kept as *ceilings*
  only. Limits are a struct the Server may tighten but never loosen: any limit above its ceiling is
  refused before the run starts. The runtime's own counters are the enforcing layer; the SDK's
  `UsageLimits` is set one step looser as a backstop (§3a.8).
- **Tool results.** `AgentRuntimeToolPolicy.maximumResultBytes` in `apps/server/src/agent-runtime.ts`
  is bounded to `1 … 128 * 1024`; the unit's tool-result bound uses the same `128 KiB` as its ceiling so
  the two policies cannot disagree.
- **A normal Python process is not an OS sandbox.** Nothing in this package claims file, network or
  process isolation, and no capability is derived from being a separate process. Isolation is a later,
  separately-reviewed gate. The unit holds no listening port, no database handle and no credentials,
  and it never reads credentials from the environment.

## 6. Interpreter and dependency resolution

- Interpreter used: CPython **3.12.13**, resolved as `python3.12` on this machine and recorded here as
  a *version*, never as a user-specific absolute path. The unit requires `>=3.12` because it uses
  `asyncio.timeout` and `ExceptionGroup`-era typing without backports; the SDK itself only requires
  3.10, so the stricter floor is this unit's own choice and is declared in `pyproject.toml`.
- Resolution is reproducible through `requirements.txt` (direct pins) plus `requirements.lock` (frozen
  transitive closure). Installation is `.venv`-scoped only; nothing is installed globally and no
  `pip install -g` path is used.
- The package is imported from `src/` via pytest's `pythonpath` setting rather than a build backend, so
  the check needs no packaging download and the Server supervises a plain interpreter process.

## 7. Explicitly out of scope

No persistence engine, no session or tracing integration, no provider SDKs, no credentials, no
scheduling, no second state store. The prior proposed method set is not implemented. In particular,
the unit does **not** claim that correlation implies exactly-once side effects, and it never submits a
final result through a path that bypasses the Server runner.

The wire *format* is no longer out of scope: §8 records the frozen one-invocation process profile this
package now implements. What remains out of scope there is anything that is not that single
newline-framed JSON-RPC request/response on stdin/stdout — no MCP transport, no multiplexing, no
reconnection, no durable session, and no OS isolation.

## 8. Process transport profile (TASK-003)

`TASK_003_PYTHON_WORKER.md` asked for a real-SDK Python CLI behind the frozen process profile, driven
as a subprocess. The profile itself is fixed by `docs/AGENT_RUNTIME_PROTOCOL.md` and
`docs/research/python-runtime-transport.md`; this package implements it and copies no source. That the
profile is a reviewed, frozen contract is the reason the wire shape, size bounds and reason grammar are
constants here rather than choices made locally.

### 8a. Standard-library behaviour verified by execution

Probes were run against CPython **3.12.13**, the interpreter §6 pins. Each is a property the codec
relies on, so it was measured rather than assumed:

- **`json.loads` accepts `NaN`/`Infinity` by default.** `parse_constant` is the only hook that sees
  them, so the profile's "finite JSON" rule is enforced by passing one that raises. Without it, a
  non-finite number would decode into a float the profile forbids.
- **`parse_constant` does *not* see decimal exponent overflow.** A finite-looking literal such as
  `1e400` overflows to `inf` *inside* the number parser, so it never reaches the hook that rejects the
  `NaN`/`Infinity` spellings. Every decoded float is therefore checked with `math.isfinite` after
  decoding, nested containers included. Verified: `{"a":1e400}` and `{"a":-1e400}` both decode to an
  infinity and are refused, while `{"a":1e308}` (in range) is accepted.
- **Duplicate object keys are silently collapsed, last-one-wins.** The default decoder keeps the final
  value; refusing duplicates requires `object_pairs_hook`. The profile has no duplicate-key notion, so
  the decoder refuses a repeated key instead of choosing a value.
- **A lone surrogate decodes but cannot re-encode.** `"\ud800"` survives `json.loads` yet raises
  `UnicodeEncodeError` on `encode("utf-8")`. Strict UTF-8 is therefore checked on the frame bytes and
  again as an encodability test, not merely by the decoder succeeding.
- **Deep nesting raises `RecursionError` from the C scanner before any value exists.** A depth bomb
  fails inside `json.loads`, is catchable, and never materialises a Python object graph — so refusing
  it is safe and does not need a recursion guard on the resulting value. An independent iterative depth
  count still runs after decoding, because the *decoder's* limit is not the profile's limit.

### 8b. Interpreter isolation verified by execution

- **`python -I` ignores `PYTHONPATH` and the working directory and does *not* add the script's
  directory to `sys.path`.** A module sitting beside the target script is therefore not importable by
  default, which is why `scripts/run-worker.py` computes its own `src` directory from
  `os.path.realpath(__file__)` and inserts exactly that one path. It adds nothing derived from the
  environment, the cwd, or a `sys.path` entry it did not resolve itself.
- **`-I` still exposes the environment and sets `sys.flags.isolated = 1`.** Isolation of `sys.path` is
  not isolation of `os.environ`, so the adapter's guarantee that it reads no environment variable is a
  property of the code (asserted by tests and by a poisoned-environment run), not of the interpreter
  switch.

### 8c. SDK message shapes verified against the pinned build

`ModelResponse` and `RequestUsage` are dataclasses, not pydantic models, in the pinned 2.47.0 build —
so the wire→SDK mapping constructs them directly rather than validating a dict:

- `ModelResponse(parts=..., usage=RequestUsage(...))`; `RequestUsage` carries `input_tokens`,
  `output_tokens` and a `details` field defaulting to `{}`. A wire `null` usage maps to the SDK's own
  default object; the adapter never fabricates a zero-usage reading it did not observe.
- `ToolCallPart(name, args, tool_call_id)` may carry `args` as a dict, a JSON string or `None`;
  `args_as_dict()` silently degrades unparseable JSON to `{"INVALID_JSON": ...}`. The adapter therefore
  parses tool arguments itself and refuses malformed JSON as `invalid_arguments`, instead of inheriting
  that permissive degradation.
- An empty `ModelResponse(parts=[])` is refused by the SDK itself (`ToolRetryError: Please return
  text`). That is why an empty model *answer* is a refusal produced by the SDK and not by the wire
  codec — see §8e.

### 8d. The reason grammar and the fixed envelopes

The profile fixes both the JSON-RPC error codes and the application reason vocabulary. `wire.py` owns
`-32600`/`-32601`/`-32602` (protocol) and `-32000` with `data.reason` (application); `profile.py` maps
a method to a runtime reason and never echoes a parent-supplied reason string, which is the Server's
vocabulary and not a channel the child may relay.

### 8e. Authority around every awaited boundary, seen from the wire

`PortModel.request` re-checks authority *after* the model port returns (`sdk_ports.py:109`), because a
revocation or expiry can land while the parent is answering. A consequence is visible on the wire and
was measured: a model reply that is valid *at the wire codec* is followed by one further
`authority.check` before the run decides its outcome, whereas a reply the codec itself refuses (a
non-string `text`, an unknown field, a negative usage) fails *inside* the port and is followed by no
further request. The subprocess tests are written to answer that trailing check; assuming the next
frame is terminal after any accepted model reply would strand the run on its deadline. This is a
property of the reviewed design, not a wire quirk.

### 8f. Interoperability with the Server's own bounds

The child's codec must agree with the parent's, so two local choices were checked against the Server's
process adapter (`apps/server/src/agent-runtime-wire.ts`, from commit `de1bed2`) rather than chosen
independently:

- **Depth is counted with the root at level 0.** The Server's `assertRuntimeJson` seeds its walk at
  `{depth: 0}` and refuses when `depth > 64`, so an empty *root* container is depth 0, `[1]` is depth 1
  and `[[[]]]` is depth 3. `wire.json_depth` reproduces exactly that, including for chains that end in
  a container rather than a scalar. (An earlier implementation counted a container as one deeper than
  its position, which diverged by one for container-terminal shapes and is now corrected.)
- **A float is admitted only if it is finite.** The Server's walk uses
  `typeof value === "number" && Number.isFinite(value)`; the child's `math.isfinite` check is the same
  rule, over the same nested values.
- **Protocol errors stay distinct from application errors.** The Server permits the fixed
  `-32600`/`-32601`/`-32602` messages for a channel failure and reserves `-32000` with a `data.reason`
  for a refused run. The child never mixes them: a `ProtocolViolation` carries only a fixed code and
  message, and an application refusal carries only a bounded reason from the closed vocabulary.

### 8g. Reproducible bootstrap

`scripts/bootstrap.sh` no longer upgrades `pip`. `python -m venv` provisions the pip wheel bundled with
the chosen interpreter, so the installer version is tied to the interpreter the package already
requires; upgrading it floated to whatever PyPI served last. The locked closure is resolved by that
bundled pip, and no new dependency was added for bootstrap.


