# Research: retained Worker Host channel in Python

- Status: Accepted for isolated migration packet; root integration remains separate.
- Date: 2026-09-24
- Acceptance journey: a synthetic Host exchanges an Owner-issued single-use token, opens a real WebSocket, receives only Server-authorized offers/assignments, and disappears on disconnect/revocation.
- Security boundary: PostgreSQL stores identity digests and audits. Server alone owns assignments and approval decisions. Frames and metadata are untrusted. No Worker effects are executed here.

## Search evidence

Reviewed existing `docs/OPEN_SOURCE_REUSE.md` entries for Node channel authority/liveness, bootstrap identity, and Python control plane. Existing `node-registry.ts`, `node-identity.ts`, `postgres-node-identity-store.ts`, `request-throttle.ts`, `client-identity.ts`, and protocol 0.9.0 define the retained contract.

On 2026-09-24, searched official GitHub releases/issues and documentation for `python-websockets/websockets`, release compatibility, size enforcement and Uvicorn settings. Sources:

- https://www.uvicorn.org/settings/
- https://github.com/python-websockets/websockets/releases/tag/17.0.1
- https://raw.githubusercontent.com/python-websockets/websockets/17.0.1/docs/project/changelog.rst
- https://raw.githubusercontent.com/python-websockets/websockets/17.0.1/src/websockets/protocol.py
- https://raw.githubusercontent.com/python-websockets/websockets/17.0.1/tests/test_protocol.py
- https://github.com/python-websockets/websockets/issues
- https://pypi.org/pypi/websockets/17.0.1/json
- https://raw.githubusercontent.com/python-websockets/websockets/17.0.1/LICENSE

## Candidate comparison

| Candidate | Exact release | License | Maintenance/tests and fit | Decision |
| --- | --- | --- | --- | --- |
| FastAPI / Starlette / Uvicorn | 0.141.1 / 1.6.0 / 0.53.0 | MIT / BSD-3-Clause / BSD-3-Clause | Already reviewed/pinned; ASGI WebSocket API plus Uvicorn bounded transport | Reuse |
| websockets | 17.0.1 | BSD-3-Clause | Released 2026-07-31, Python >=3.11, no required runtime dependencies; source tests cover oversized/fragmented frames, masking, control frames; Uvicorn SansIO adapter uses current `ServerProtocol` | Add exact pin |
| wsproto | Existing Uvicorn alternative, not selected | MIT | Another protocol backend unnecessary after first viable candidate | Not added |

Read installed Uvicorn 0.53.0 SansIO adapter: it passes ws_max_size, disables compression when configured, bounds receive backpressure, and has native matched-payload ping/pong timeout. Set ws='websockets-sansio', ws_max_size=33554432, ws_ping_interval=30, ws_ping_timeout=30, ws_per_message_deflate=False. The backend enforces the 32 MiB bound before delivering an ASGI message. App-only length checking is insufficient.

Open upstream issues checked include percent-decoding proxy credentials, percent-encoded IRIs, and non-UTF8 control-frame logging. Production use is server-side with no proxy URL, no payload logging, and no client redirect path. Test clients explicitly disable proxy/compression. No relevant size/ping failure was identified; tests remain required.

## Reuse decision and incorporation

Use the released backend as a dependency and thin ASGI adapter; do not implement WebSocket framing or a second authorization protocol. Only packet temporary target dependency installation is allowed in this task, not root environment mutation. Missing/incompatible backend fails startup integration; root must pin/install it. No upstream source is copied or substantially adapted. Preserve the dependency's packaged BSD-3-Clause LICENSE in distributions. OpenBot's existing MIT business rules are migrated. New Python code owns only the existing protocol-to-runtime gap.

## Verification and limits

Real loopback Uvicorn and synthetic PostgreSQL tests must cover enrollment reuse, rotation, invalid/duplicate hello, frame limits, stale/replayed responses, disconnect/pending cleanup, heartbeat non-authority, cancellation, callback delivery and shutdown. Tests perform no real device command, browser, OS Provider, or external model call. Runtime dispatch and durable node projection are callback consumers integrated by root. No proof-of-possession or mTLS claim is added; retained bearer credentials and Server revocation remain the contract.
