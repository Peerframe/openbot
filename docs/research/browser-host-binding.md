# Browser profile host identity binding

Reviewed before implementation on 2026-09-26 at OpenBot `1978bcb4d46160ecd75a0c862328495876a71e53`.
This is product authority work; the separate PR #96 task owns CI repairs.

## Reuse and evidence

Reuse the MIT OpenBot Python browser session and authenticated Worker adapters, already reviewed
in [browser sessions](python-browser-sessions.md) and `docs/OPEN_SOURCE_REUSE.md`. Keep the
separate CopilotKit/OpenBot agent-computer at
[`257c1280d684089be9adb0b35cce262efc7064bf`](https://github.com/CopilotKit/openbot/tree/257c1280d684089be9adb0b35cce262efc7064bf/agent-computer),
MIT, and Playwright 1.62.1, Apache-2.0. No third-party source is copied or dependency added.
Re-read the pinned `profiles.ts`, control implementation/tests and package/license evidence
retained for the accepted browser qualification. The upstream selects a persistent directory
by Bot identity; that does not establish which enrolled OpenBot Worker owns that directory.

Primary checks on this date: GitHub search for `CopilotKit/openbot agent-computer browser profiles`,
[upstream configuration](https://github.com/CopilotKit/openbot/blob/main/docs/configuration.md),
[Playwright authentication](https://playwright.dev/docs/auth), and
[PostgreSQL 18 locking](https://www.postgresql.org/docs/18/explicit-locking.html).
The pinned GitHub tree was unavailable through the web reader, so exact source and hashes use
the existing reviewed upstream cache. Current upstream documentation is contextual, not a new
source pin. Browser authentication state is sensitive; PostgreSQL session and row locks supply
the existing serialization primitives, but neither establishes profile ownership on its own.

## Concrete gap and chosen thin adapter

Browser views retain only a Node name/id today. Enrollment can replace that Node's credential,
including from another Server process. A stale live socket or a new computer using the same id
must not receive browser input or return a frame under the old view/profile authority.
Reusing the existing Worker connection id, credential digest and PostgreSQL identity row is the
first viable option. No new browser library, workflow engine or profile store is needed.

Capture an immutable internal connection binding. Require it at browser dispatch and recheck
inside the socket send lock; never add its credential digest to the wire or public view. Persist
the first browser host's credential digest in a separate Server audit binding event. Later opens
must match that durable identity, including after Server restart. Check current non-revoked
identity before intent, at send and before frame publication. Old history lacking an identity
binding is explicitly unverified and cannot be silently rebound. Same-credential reconnect allows
a new view; stale views remain invalid. Credential rotation requires a separately authorized
profile rebind, which this increment does not implement.

Keep uncertain input paused, even if release reached the Host but final identity validation fails.
Distinct Bot profiles retain independent gates. Human takeover and Agent browser execution remain
default-off until complete Work authority/egress/effect integration is accepted.

## Focused validation

Use real owned PostgreSQL and public HTTP/WebSocket enrollment with synthetic browser frames.
Cover stale view reconnect, credential replacement/revocation on another Server process, replacement
between intent and send, replacement after release delivery, durable restart binding, unbound
legacy history, distinct Bot isolation, and normal input/release. No VPS, real browser, provider
account or migration of user login data is involved. Run the adjacent Worker transport suite and
required repository check. These checks establish the authority adapter, not real browser profile
storage, egress or the full Work browser journey.

## Integrated result

DeepSeek (DSH headless) implemented the frozen registry binding and exact-connection checks;
root integrated the Server authority, durable binding and client state changes. DSH received only
one public MIT source file whose bytes matched GitHub commit `1978bcb` (SHA-256
`6147d4267c64c81c21739a49c670b397214f7d5362da179615791c17ba8f4c97`) and the bounded implementation
instructions. The initial packet was rejected by automatic approval review; the public-only packet
was allowed after independently verifying repository visibility and source bytes. No internal
research, user data or credentials were sent. DSH performed syntax checks; root ran repository tests.

On 2026-09-26, the three focused browser/session/Worker socket modules passed **43 tests** (41 combined and two additional focused cases) using
fresh owned PostgreSQL with all 43 canonical migrations and real loopback HTTP/WebSocket traffic.
The adjacent negotiated command-channel suite passed **31 tests** in the locked Worker environment.
The React browser suite passed **8 tests**, including clearing frames and unsent input on revoked
session authority. `npm run check` passed; changed Web tests/build executed, unchanged Turbo tasks
reused cache. The obsolete prior test database was unavailable; it was replaced by a new disposable
fixture, not treated as a product failure or skipped gate. One initial aggregate invocation used the
base environment for a Worker-only module and failed collection; the actual Worker suite above
used its existing exact dependency closure. All regressions live in the repository and are included
by the existing owned-PostgreSQL/base/Worker entry points; no maintainer-private fixture is needed.

Product work is on `codex/browser-product-integration-20260926` in the original c8b2 worktree.
The separate task owns PR #96 CI files/repairs. This increment closes browser host identity and
view authority only; Work browser admission, physical profile binding, egress, complete human
handover and old TypeScript business Server retirement remain open. No default capability,
installation, VPS retry, merge or production release was performed.
