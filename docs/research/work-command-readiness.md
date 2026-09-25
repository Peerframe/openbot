# Research: Work command preparation and causal deadline verification

- Status: Implemented inactive Control/protocol candidate; remote integration remains open.
- Date: 2026-09-25.
- Acceptance journey: an approved original Work Action reserves once, accepts signed readiness inside
  its original causal window, admits and consumes once, then permits only original lookup.
- Security boundary: Control remains sole Work authority; Node is an untrusted relay; an independently
  pinned protected enforcer signs actual native observations. No new scheduler or approval authority.

## Search evidence and exact sources

Research was completed in the accepted design before implementation. Repository entries checked:
ADR-0045, OPEN_SOURCE_REUSE, work-command-authority, work-command-transactions, linux-vps-qualification,
the existing native deadline probe, Worker registry/protocol and Node client. GitHub/source searches
covered `systemd RuntimeMaxUSec transient UNIT_STUB`, `service_running_timeout`, `unit_arm_timer`,
`NTPSynchronized maxerror`, `Type=exec timeout`, and `CLOCK_BOOTTIME suspend`.

| Candidate / exact pin | Primary evidence, license and fit | Decision |
| --- | --- | --- |
| systemd v255, db11bab38ccf1ed257f310d29070843d4c58ea01 | [service.c](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/core/service.c), [dbus-service.c](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/core/dbus-service.c), [unit.c](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/core/unit.c), LGPL-2.1-or-later; maintained release source/manuals and prior native probe reviewed | Set original duration before unit creation; no running-unit shortening or job-timeout substitute |
| Same systemd pin | [service manual](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/man/systemd.service.xml), [timedated.c](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/timedate/timedated.c) | Runtime uses monotonic active time; NTPSynchronized does not establish a five-second permit error bound |
| Linux man-pages 6.19 | [clock_gettime](https://man7.org/linux/man-pages/man2/clock_gettime.2.html), [unix](https://man7.org/linux/man-pages/man7/unix.7.html); primary API documentation | BOOTTIME nonce/boot check plus qualified rate envelope; protected Unix socket is transport containment, not authority |
| RFC 9449 §§8,11; RFC 8725 §3.12 | [nonce/replay](https://www.rfc-editor.org/rfc/rfc9449.html), [distinct JWT types](https://www.rfc-editor.org/rfc/rfc8725.html#section-3.12) | Reuse principles; this is not a new OAuth/DPoP implementation |
| joserfc 1.7.5 / 357c319119773c021bc8da433bdf31e42f77974b; rfc8785 0.1.4 / 4d9b161f6054301d98d0566e813d020fb019ee10; cryptography 50.0.1 | Existing command authority review records source, releases, tests, issues and advisories; BSD-3-Clause, Apache-2.0, Apache-2.0/BSD | Reuse exact locked JWS/key/JCS implementation; no new cryptographic core or install |
| jose 6.2.12 / 505a55b8f73536082367b2614cb77e927ba96ec1; canonicalize 5.0.0 / 7d97c70c79c9f52070e6c24c38a92f0dd9b32a57 | Prior cross-language review, MIT / Apache-2.0 | Retain TS relay direction and interoperability; this packet does not replace Node |

The recorded real-host precursor was systemd 255.4-1ubuntu8.17. Four existing native-stop cases
observed 0.118–0.301 seconds past nominal expiry with a predeclared five-second observation allowance.
Those observations are not a universal hard-real-time guarantee and were not rerun in this slice.

## Reuse decision and local gap

The first viable path is released JOSE/JCS libraries plus a narrow adapter over existing Work
transactions and systemd/native precursor. No maintained standard library supplies OpenBot's source,
Action, SDK history/fence, file scope and original enforcer identity transaction. Those exact bindings,
strict v2 schemas and causal interval bookkeeping are the local code. A shared lookup/stop challenge
closes delayed-first-output disclosure without introducing a second timing service.

The accepted explicit changes are original-epoch reservation before preparation, and nativeDeadline
as a conservative Server-domain cessation upper bound equal to hardDeadline. The protocol advances
to 0.10.0; source/intent remains v1. Incompatible purpose, signature, clock, source, inputs, epoch or
readback fails closed. Protected native readback/guard and current-authority control-request issuance
are required integration, not facts established by a signed DTO or the component tests.

## Source incorporation

No upstream source is copied or substantially adapted. Existing repository JWS/key parsing and
contract primitives are reused through imports. Upstream source downloaded for review remains review
material, not product code. No new dependency or notices are added by this slice.

## Verification and remaining boundaries

139 tests passed: 81 adapted existing real-PG cases, 22 new real-PG preparation cases, 36 pure
crypto/time/frame cases. Negative cases include concurrent preparation/consume, rollback and cancel
ordering, wrong native identity/readback, changed files/member/fence, original deadline preservation,
Server restart or wall/monotonic changes, Host boot/suspend/restart, late first control delivery,
operation/request/nonce/digest mismatch, and bounded canonical chunks. All owned fixture resources
were removed. English and Chinese readiness notes state the same inactive support level.

This is not live Host/Node/product execution, a provider call, browser support, NTP synchronization or
unconditional real-time scheduling. Production clock/rate/stop qualification, protected persistent
once-only producer state, chunk receivers and actual authority-to-output integration remain open.
The integration must use current lookup/stop authority paths and never expose an arbitrary signer.

## Current-authority lookup and Owner stop composition

Before implementing the Control request issuer, the same PostgreSQL17 row-lock documentation,
RFC8725 section3.12 and RFC9449 nonce sections were reread. The existing pinned JOSE implementation
and typed v2 control challenge are the first viable reuse; no new crypto/dependency is needed.
The gap is the Work-specific permission transaction, not another generic signer endpoint.

The internal lookup issuer must hold files, current registry identity, source/ancestor Task,
Action and original dispatch locks; validate current immutable profile, original accepted SDK
activity/claim/fence/correction, unchanged inputs and explicit approved Action; and bind the exact
Host challenge/request/nonce. Output requires a consumed original dispatch. Receipt collection may
occur after the execution hard deadline but never refreshes it. Lookup does not admit, consume,
settle, recreate a unit or publish an artifact. Current claim/Action expiry bounds disclosure.

Stopping is separately authorized by a current Owner session in the existing Owner transaction.
It may stop only the exact retained preparation/dispatch using a fresh protected Host challenge.
It remains available after Task cancellation or removal of source membership, without restoring
Work authority or disclosing output. Current authenticated connection and credential must still
match the frozen profile; a revoked/offline Node relies on the original independent native deadline.
Neither API is a public arbitrary-token signing route. Failed or changed checks return no token.
No upstream source is copied; targeted real-PG tests must cover both permission boundaries.

The integrated current-authority issuer passed16 real-PG cases, including cancelled/membership-
removed Owner stop with no output access, invalid Owner sessions, changed input/model/Node/fence/
generation/clock refusal, and unchanged original dispatch identity. These internal methods do not
register a public route or close product receipt/artifact integration. The first broad43-entry gate
passed825 base cases and1056 Worker cases;22 late Worker failures were the original synthetic session
expiring after600 seconds (107-second base plus498-second Worker run). The owned harness TTL was
extended to1800 seconds for the full suite, without changing product Owner-session settings.
