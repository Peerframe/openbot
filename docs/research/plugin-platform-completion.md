# Research: MCP resources, prompts, apps and reviewed updates

- Status: Accepted for implementation
- Date: 2026-09-10
- Owner: OpenBot contributors
- Acceptance journey: Owner reviews a plugin's resources and prompts, grants individual capabilities to a Bot, reads them in that Bot's channel scope, and explicitly replaces changed declarations with grants reset.
- Security boundary: Server owns identity, digest, grants and revocation. Content and HTML are untrusted; resource URIs are MCP identifiers, never local paths or direct fetch targets.

## Search evidence

- GitHub searches: `modelcontextprotocol/typescript-sdk 1.30.0 resources prompts issues`, `modelcontextprotocol/ext-apps releases sandbox`.
- Reuse ledger: existing third-party MCP tool plugins entry and `third-party-mcp-plugins.md`.
- Inspected installed SDK 1.30.0 client source (`listResources`, `readResource`, `listPrompts`, `getPrompt`, capability checks), MIT license, prior reviewed source commit `2d889f2b329e46680ec9bdd565de4616c497825a`, upstream integration tests and session expiry issue 1708 recorded in the existing review.
- Standards: [resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources), [prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts), [MCP Apps 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).
- Apps maintained candidate: [ext-apps releases](https://github.com/modelcontextprotocol/ext-apps/releases); reviewed specification plus release v1.5.0 (`621a70a`) and later lifecycle fixes #623, #629, #631. These show that a naive postMessage renderer is not equivalent to an Apps host. Root host integration must pin its selected dependency separately before adding it.

## Candidate comparison

| Candidate | Exact version | License | Fit and decision |
| --- | --- | --- | --- |
| Existing official MCP SDK | 1.30.0, `2d889f2b329e46680ec9bdd565de4616c497825a` | MIT | Released, supported Node client already installed; reuse standard discovery/read methods and existing bounded network transport. |
| MCP Apps | 2026-01-26; ext-apps v1.5.0 review | Apache-2.0 | Reuse resource MIME/metadata and isolated host lifecycle. Web host requires separate-origin sandbox proxy and restrictive CSP. Host implementation is a separate coordinated module. |
| Custom plugin fetch/eval | Local | N/A | Rejected: would duplicate MCP and expose host-origin execution. |

## Reuse decision

Add a thin bounded adapter to the existing SDK. Catalogs have up to 32 entries per capability; exact resources and prompt names are individually granted. Input/output have byte, count and schema limits. Prompt results remain untrusted user-selected material, never system instructions. Resource-only services are permitted. No subscriptions, arbitrary URI templates or unbounded pagination are silently supported.

Old tools-only digests remain compatible. New resource/prompt/app declarations are included in review digests. Update preview does not mutate installation; apply requires revision plus fresh digest and disables the plugin, clears every grant and revokes active calls. No external program is downloaded or executed by update.

Apps resources return bounded HTML only for an explicitly granted `ui://` resource with `text/html;profile=mcp-app`. Network/resource domain permissions are denied by default; declared CSP and permissions are surfaced for host enforcement, not authority. Unsupported metadata fails closed.

## Source incorporation

No upstream source copied or substantially adapted. Existing SDK remains pinned; no new dependency in this workstream. Existing third-party notices cover its MIT license.

## Verification plan

Run existing lifecycle tests plus resource/prompt discovery, required/unknown prompt arguments, cross-Bot denial, stale digest, update review races, grant reset, result bounds, unsupported payloads and real local SDK server roundtrip. Root verifies UI sandbox and Windows host independently. Bilingual plugin guide records bounds and unsupported optional protocol features without claiming full MCP conformance.

## Host dependency review (before host implementation)

Selected `@modelcontextprotocol/ext-apps` **1.7.5**, commit `92f46a574568a3ddac7600343b7d3c4c4ed7b588`, tarball integrity `sha512-TjPH2S2y5UEGKhmI6+XGFuqfqOV4ppe1x6DA3txnUaEWkgtA4G5vo14jGKFZmegdkZ1H4QMLyujLvoU1BEdnAg==`. Inspected the published AppBridge, PostMessageTransport source, declaration files, packaged test declaration coverage and full LICENSE. The license file records Apache-2.0/MIT transition and documentation CC-BY-4.0; npm's short MIT field is incomplete. Preserve the upstream LICENSE in distribution. [Release 1.7.5](https://github.com/modelcontextprotocol/ext-apps/releases/tag/v1.7.5) includes initialization capability fixes, specification CSP fixes and reviewed advisory remediation. Its MCP SDK >=1.29 peer accepts our 1.30.0; React19 and Zod4 also fit. [Release 2.0.0](https://github.com/modelcontextprotocol/ext-apps/releases/tag/v2.0.0) requires split SDK2, while wire interoperability is unchanged and tested upstream; no need for that migration.

Use released AppBridge and PostMessageTransport without copied implementation. OpenBot's missing adapter is a bounded, source-checked connection to its Owner API and a deny-network sandbox wrapper. A trusted data-URL proxy has an opaque origin distinct from the host; it wraps an inner `allow-scripts` iframe, applies restrictive CSP before HTML content, and forwards only bounded JSON-RPC. Do not grant popups, top navigation, forms, downloads, same-origin to the view, devices, external URLs or model-context/message mutations. Close the bridge on unmount and discard stale requests. Prompts are selected before execution through real channel+Bot membership, never a fabricated Run.

## Verification results

- 2026-09-10: 21 Server tests (existing tool lifecycle plus content/update/Owner scope) and 9 UI/containment tests passed. Server and web TypeScript checks passed. The real local SDK server supplies text resources, required-argument prompts and an HTML resource; there are no external accounts or paid model calls in this evidence.
- Chrome CUA at `http://127.0.0.1:5202/`, synthetic API data: official AppBridge initialized through an opaque data-URL proxy and inner sandbox; click counter changed 0 to 1; inner `resources/read` returned the scoped notebook text. Explicit prompt preview was inserted into a draft without dispatching a task. Update controls required the reviewed checkbox before submission.
- A synthetic adversarial view showed parent DOM access blocked, localStorage blocked, fetch blocked by CSP, and unadvertised `tools/call` rejected. The host also used a parent `frame-src data:` policy. No private data was used or copied. These checks validate the tested Chromium containment boundaries, not an all-browser security certification.
- At 390×844, document width and scroll width were both 390 and the content panel was 350 pixels; controls and prompt preview remained readable without horizontal overflow. The normal desktop view also rendered correctly. Temporary viewport override was reset.
- Native browser execution caught a quoted-CSP JavaScript syntax error and missing required notification `params`; both were fixed before handoff. A trusted-proxy compile regression check now covers the syntax path. Routine development fixture HMR logs are not production failures; deliberate CSP probes produce expected console rejection messages.
- Apps expose local interaction and explicitly granted resource reads. Tool invocation, message sending, model context mutation, external network/device permissions and automatic external-service upgrades are not advertised. MCP optional templates, subscriptions and pagination remain unsupported and bounded failures are documented.

### External material must not mint attachment references

The existing attachment marker is an OpenBot transport convention, not MCP content authority. Review of the MCP 1.30.0 untrusted resource/prompt boundary and current `taskAttachmentIds` parser found that blindly inserting external text could reinterpret a reserved marker as an Owner attachment selection. The narrow adapter neutralizes every case-insensitive reserved prefix in the entire inserted label and body. Resource preview remains original text; only the draft transport representation changes. A real component test supplies a malicious prompt marker and verifies the callback cannot receive an active marker. No upstream source is copied or new dependency introduced.

### Approval timeout classification

Hosted Linux CI exposed a clock-domain bug: the approval timeout signal could fire before the separately calculated wall-clock `expiresAt` appeared expired, turning a known approval expiry into generic plugin unavailability. The Node `AbortSignal.timeout`/`AbortSignal.any` API provides the actual originating signal state (https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay). Keep that signal and classify its abort directly, with parent cancellation taking precedence. Preserve the wall-clock expiry for approval admission. A regression freezes `Date.now` while the real timeout runs, verifying expiry without external dispatch. No deadline is increased and no automatic retry is added.

## Standalone author starter and update comparison (2026-09-11)

Reviewed the existing MCP SDK 1.30.0 source/tests, the local example and the public 2025-11-25 transport plus Apps overview again. GitHub query `modelcontextprotocol/typescript-sdk 1.30.0 StreamableHTTPServerTransport` surfaced issue 2730 (notification acknowledgement with `Connection: close`); the starter retains the tested SDK transport and does not add that header. No v2 SDK migration is required for the current protocol scope.

Reuse the existing example as the single source, copying its two bounded source files and license into an exclusively created standalone directory with pinned SDK/Zod/tsx dependencies. Creation never installs dependencies, starts a listener or modifies the OpenBot runtime. Verify from a fresh directory after an independent dependency installation. Keep `tools`, `resources`, `prompts` and App-view limits explicit. Add a presentation-only comparison of old/new named declarations before update and status-specific connection errors. No upstream source copied and no dependency added to the core.

## Production CSP repair (2026-09-11)

Real built-Web verification found that the data-URL proxy inherits the host's restrictive CSP,
so its inline bridge script cannot initialize. The earlier synthetic development check did not
exercise that production policy. Rechecked the pinned ext-apps 1.7.5 source above, its
[double-frame specification](https://github.com/modelcontextprotocol/ext-apps/blob/92f46a574568a3ddac7600343b7d3c4c4ed7b588/specification/2026-01-26/apps.mdx),
[W3C CSP3 2026-08-13 inheritance](https://www.w3.org/TR/2026/WD-CSP3-20260813/#security-inherit-csp),
and the [HTML sandbox rules](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox).
Reuse Vite 8.2.2's existing asset emission and development middleware APIs to serve the fixed proxy
as a separate document. Both frames use `allow-scripts` without `allow-same-origin`, giving them
opaque origins; plugin HTML remains exclusively in the inner frame. Only this trusted proxy
permits inline scripts. The host keeps `script-src 'self'`; the view retains no network, forms,
popups, devices, top navigation or host authority. No dependency or upstream source is added.
Validate against the production build with a real installed MCP example and reject hostile view
attempts; a string-only unit test is insufficient evidence of browser CSP behavior.

Production browser result: using a real Server/Postgres workspace and the independently scaffolded
MCP example, the built Web host completed AppBridge initialization, counted a click, and read the
authorized notebook resource. A temporary hostile view probe could not read the top document or
cookies and its direct fetch was blocked. Revoking content permissions removed the open view;
a subsequent changed tool declaration appeared in update review and applying it disabled the
plugin and cleared grants. These are browser observations, not native Desktop or Windows proofs.

The follow-up native regression uses the existing Electron 44.2.0 binary with a disposable hidden
file renderer and the actual built proxy/CSP. macOS passed: the proxy initialized, host/proxy DOM
and cookie access were denied, and a real listening loopback probe received zero requests.
`apps/desktop/scripts/check-plugin-sandbox.ts` now runs in native macOS/Windows CI after build.
It is a renderer boundary check, not an installed-app/keychain or signed-distribution claim.
