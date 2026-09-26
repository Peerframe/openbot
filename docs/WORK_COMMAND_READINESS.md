# Offline command readiness — inactive Control/protocol candidate

This slice replaces caller-supplied native deadlines with one durable, signed preparation fact. It
provides Control transactions, a protected Host interface and protocol 0.10.0 frame schemas.
The optional product composition is integrated and disabled by default. The existing Work Action remains the only approval
and admission authority. Browser execution is outside this slice.

Qualification uses `OPENBOT_CONTROL_COMMAND_CONFIG_PATH` only together with product authority and an
explicit Temporal configuration. The [configuration schema](../experiments/linux-execution/command-installation.schema.json)
and [non-deployable example](../experiments/linux-execution/command-installation.example.json) describe
the fixed route, pinned image/limits, timing and separate signing roles. Loading a config grants no
Work authority; source capture, current identity, Owner approval and online consume remain required.
Invalid explicit configuration fails startup. Keys/config must be locally owned regular files;
Control private material is never sent to Node. The current Host scope is at most50 seconds plus
5 seconds stop observation. The product output limit is64KiB of complete UTF-8 evidence, with a
16KiB untrusted model excerpt; final review and artifact publication use the complete private bytes.
Same-connection original lookup is supported; reconnect recovery has not been qualified.
The trusted command adapter selects a fixed120-second Activity claim so the reviewed preparation
and stop envelope fits; generic tools retain60 seconds. This neither renews a replayed claim nor
extends the original Task/Action/native deadlines.

An explicitly Owner-approved original Action may reserve preparation once. That record fixes its
original epoch, source/profile, connection/route, input scope and native unit identity before remote
staging. An enforcement key distinct from the Node credential signs a local boot-bound challenge;
Control checks current Work/source/file/fence authority before returning authorization for fixed
staging. Staging omits model argv. The pinned native helper must reject an expired startup nonce
before spawning any producer. Input bytes remain bounded by the existing 20 MiB manifest; chunks are
at most 16 KiB, complete JSON frames at most 32 KiB. Node remains an untrusted relay.

A first valid native-readiness receipt fixes a conservative Server-time stop upper bound, not a
purported conversion of host monotonic time to UTC. For fixed qualified timing policy, Control accepts
readiness only within the original round-trip budget B and records D=t1+U(R)+S. It first requires
`t0+max(B,U(Q))+U(R)+S <= original root/Action/claim bound`, and `U(R)+S <= approved wall ceiling`.
`nativeDeadlineMs == hardDeadlineMs == D`; original boot, invocation and monotonic observations remain
in the signed proof. Neither lookup nor a later Activity epoch can choose another deadline or unit.
The first five-second online consume permit applies only after input/runtime preparation completes.
Unknown delivery permits only original lookup, never another consumption or execution identity.

`CommandDispatches` now requires the existing mandatory `CommandInputScope`, a qualified timing
policy and a process-bound `ServerPrepareClock`. Call `start()` before `reserve`,
`authorize_preparation`, `accept_ready`, `admit` or `consume`. `admit` accepts only preparation_id,
not a PreparedCommand or a deadline integer. The old preparation method is removed. Work source and
command intent remain version 1; execution tokens and deadline profile become version 2. Source
Run.model_selection remains NULL, with the existing independent immutable command profile selection.
The transaction order remains files lock, registry identity guard, existing source/ancestor Task and
Action locks, preparation/dispatch, credential read. No network await runs inside those SQL locks.

Lookup and stop share a fresh local Host challenge. Current authority must be checked before Control
signs a typed response bound to its exact challenge digest, request and nonce. The Host rejects a
late first response and checks the unchanged bounded interval before each output disclosure. Lookup
access is not granted by a Node credential, an old receipt or a Server nonce alone. Stop never grants
output access. Signatures identify the trusted producer; validated observations, bounded receipt
collection and existing artifact/result review still determine the effect.

Migration `0042_work_command_preparations` adds `work_command_preparations` and preparation/readiness
references on dispatch, bringing canonical history to 43 entries. The TypeScript mirror adds 362
Python-oracle vectors and three JavaScript boundary cases; the existing global 0.9.0 Worker handshake
remains unchanged while this command-only candidate is inactive. Do not backfill
historical v1 dispatches into executable v2 facts. No new dependencies are required. Pure Host modules
reuse existing strict JWS/key/JCS code and import no database, Temporal or model service.

Validation: 139 tests passed on a fresh owned PostgreSQL 17.11 container using canonical 42 migrations
plus the candidate. All 81 retained authority tests were adapted to the public readiness API; 22
additional database tests cover preparation races, signed native-readback changes, late/restarted or
clock-shifted observations and current input/member authority. Another 36 pure tests cover causal
execution intervals, shared control challenges, replay, suspend/boot changes, inner/outer correlation
and frame boundaries. PostgreSQL, OwnerFiles and SDK ActivityEnvironment are real; immutable history,
transport, protected enforcer and clocks are explicit synthetic seams. The owned container and volume
were removed. No provider network, VPS, live product Worker or command workload ran in this slice.

The protected Host, native adapter, authority-gated control signing, Node transport and bounded
manifest receivers are now integrated. The remaining execution gate is the complete product
journey on the real Linux Host, including native readiness, original execution, cleanup and final
output/review. Local fixture success cannot substitute for that host evidence. The Host retains
finite preparation/action and control-book capacity and refuses exhaustion; no eviction/re-arm
API grants another execution. A qualified non-suspending host is required; ordinary systemd timers
do not establish unconditional hard real-time cessation under arbitrary kernel/VM stalls. Product
execution remains disabled by default until the real gates close.

## Integrated control access and relay

The optional Node relay is now in the repository. It has no default installation/capability;
24 injected transport/client cases passed, and the latest full Node suite passed92 cases with3 existing
platform skips. These are transport boundaries, not real Host execution.

`authorize_lookup` rechecks the original active Work/source/SDK fence, input bytes, profile,
credential and approved Action before signing a fresh Host-bound lookup. Output requires the
original consumed dispatch. `authorize_owner_stop` requires a current Owner session and permits
only stopping the exact original unit, including after cancellation; it grants no output access.
The APIs are internal, with no arbitrary signer route. Sixteen real-PG tests cover these boundaries.
Final receipt settlement, artifact review and socket integration have passed through the actual
local product entry, Owner approval, PostgreSQL/mTLS Temporal and OpenBotNodeClient. One original
command, complete CSV output, separate review, two artifact downloads and offline replay passed.
Native execution, peer identity and model HTTP in that journey are explicit fixtures; see
[scoped evidence](../experiments/work-journey/evidence/product-command-local.json). Real Linux
product composition remains open and public execution stays disabled by default. The browser CDP
component has separate bounded acceptance; product browser/handover remains open.
The actual protected Linux Host component has separately passed one original signed command, exact
CSV output, native expiry and cleanup; its Control signer was synthetic. See
[component evidence](../experiments/linux-execution/REAL_PROTECTED_COMMAND.json).

The authorized product2 remote attempt failed before run/Action reservation because its tiny
enrollment envelope selected an unsupported1024-byte codec limit. The fixture now uses the
existing512-byte class, with six actual-stdin regressions and161 controller/Host tests passing.
No native execution occurred; owned resources were reconciled and existing services were unchanged.
[Failure evidence](../experiments/work-journey/evidence/product-command-remote-product2-attempt.json)
is retained. A fresh product3 packet awaits its specific authorization; product2 is not retried.
