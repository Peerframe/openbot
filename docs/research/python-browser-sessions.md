# Human browser session migration review

Reviewed before implementation on 2026-09-25. Source: OpenBot MIT feature commit
9cc73c9e78451e572f57d142d6b9caf62ccb78e2, ADR-0028 and docs/research/employee-browser.md
(English and Chinese), existing OPEN_SOURCE_REUSE.md browser session and Provider SDK entries.
Current integration baseline retains protocol 0.9.0 authenticated /ws/nodes, bounded
computerRequest, explicit Origin policy, OwnerTransactions final authorization checks and
controlled browser.input approvals. Those contracts must remain intact.

Reuse original browser DTOs, EmployeeBrowser UI, BrowserCommandHost and BrowserCoordinator
through bounded adapters. Existing MIT source is copied/adapted and root LICENSE is retained.
The separately reviewed CopilotKit/OpenBot agent-computer pin is
257c1280d684089be9adb0b35cce262efc7064bf, MIT; its runtime license and Chromium notices remain
required. No runtime source, new dependency, engine, framework or default release is introduced.
Existing Pydantic 2/FastAPI/psycopg, Zod4.6.2, React19.3.0, Vitest5.0.0 and ws are reused.

Local gap: translate Server session authority to Python Owner-token-first PG transactions,
add negotiated browser.session@1 relay to current WorkerHostRegistry, keep Human/Agent pause
serialization explicit, and restore two narrow UI entries in the current App. Root owns Work
Temporal integration and startup. Session control is not a long-lived Owner authorization;
every request, dispatch and result publication rechecks current Owner and Employee authority.
Mutations are audited before delivery and uncertainty never replays input or resumes Agent work.

Available environment: owned PostgreSQL fixture browser_sessions.json; real public Node
enrollment can be exercised. Read-only docker ps confirms no agent-computer browser container
is running. Synthetic localhost Worker/browser endpoints will prove protocol and adapter
lifecycle only. This does not claim Linux/runsc or real browser runtime positive conformance.

Implementation review: source browser.ts protocol/UI/Node host/Provider coordinator were copied
and adapted locally; current Provider navigation/private-host policy, bounded computerRequest,
controlled browser.input approval path and authenticated Node handshake were retained. Navigation
additionally rejects non-HTTP(S) and credential-bearing URLs before the upstream control transition.
The Provider serializes navigation/observation/preparation and click commit with human commands,
but waits for Server approval outside that queue. A human take rotates the opaque local generation
before the upstream request; returning control cannot revive the earlier approval. See the
[handover ordering repair](browser-approval-handover.md). This local fence supplements, rather
than replaces, the Server-owned pause/lease gate below.

The Python translation adds a PostgreSQL session advisory lock shared by Human and Agent calls,
using existing run_events for append-only BROWSER_CONTROL_STATE records. No schema migration is
needed. Records contain only paused/sessionId/expiresAt, while command audit contains actor,
requestId/action/phase. No typed input, URL, frame, token or raw Provider failure is durable audit.
Owner authority is checked before input parsing, in intent transaction, at actual socket send,
and before result publication. A failed final release commit retains durable pause.

Both integration switches are explicit opt-ins: BrowserSessionsService(agent_gate_configured=False)
and createDockerProvider({enableBrowserSessions:false}) default to no human takeover support.
The root currently refuses docker-linux Work admission. Enabling the first switch is only valid
after every real Agent browser effect holds the shared gate for its complete lifetime. Capability
advertisement alone does not meet that condition. No environment-based activation was introduced.

Independent local evidence: PostgreSQL/real localhost HTTP+WS tests use public Node enrollment;
TS tests run the actual authenticated Node client and opt-in Docker adapter against a synthetic
computer HTTP service. The synthetic HTML endpoint is not rendered by Chromium. PNG checks cover
base64, signature, dimensions and size, not a complete image decoder. React behavior is covered
by JSDOM tests; final rendered UI acceptance remains with root integration.


## Retained TypeScript backend boundary, 2026-09-25

The shared Worker protocol now includes browser.result for the Python candidate. The
retained TypeScript Node registry has no browser-session authority, so it explicitly rejects
that message and closes the socket with 1008/browser-session-unavailable instead of treating
it as an execution offer. Eight registry tests passed, including an enrolled real WebSocket
client sending a valid browser result and receiving refusal without publishing Run messages.
This is a compatibility refusal; it does not qualify browser isolation or takeover.
