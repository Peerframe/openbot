# Research: MCP OAuth account lifecycle

- Status: Proposed; research only, no OAuth product support enabled
- Date: 2026-09-23
- Baseline reviewed: integrated OpenBot `820d17d`; MCP SDK installed at `1.30.0`
- Related work: P2 account connections; [existing MCP reuse](../OPEN_SOURCE_REUSE.md#third-party-mcp-tool-plugins), [plugin research](third-party-mcp-plugins.md), [compatibility preflight](mcp-compatibility-preflight.md)
- Acceptance journey: an authenticated Owner connects a synthetic protected MCP service, grants one Bot one tool, survives a Server restart and token rotation, then disconnects with no further dispatch or replay.
- Security boundary: the Server owns credentials, identity binding, grants, revisions and audit. OAuth access does not grant a Bot permission. The first deliverable uses disposable local services, not personal accounts or a paid model.

## Decision

Build a preregistered-client lifecycle around the installed MCP SDK. Reuse its public
`OAuthClientProvider`, discovery helpers, `auth`, `exchangeAuthorization` and
`refreshAuthorization`. Add the narrowly scoped, released `oauth4webapi@3.8.8` **in a later
implementation change** for `validateAuthResponse`, `revocationRequest` and
`processRevocationResponse`, which cover public client APIs missing from SDK 1.30.0.
No dependency is added by this research.

Keep OAuth orchestration outside `StreamableHTTPClientTransport.authProvider` on the tool-call
path. Obtain a usable token before dispatch, then use the existing bounded, same-endpoint
transport without automatic authentication retries. A tool request receiving 401/403 or losing
its response must not be replayed after refresh or login. Reuse durable plugin receipts for
ambiguous calls; reconnecting an account never resumes an abandoned effect.

The smallest deliverable supports one account connection per plugin, one Server process,
authorization code + PKCE S256, preregistered clients and explicit issuer/resource profiles.
It includes restart, rotating refresh tokens and local/remote disconnect outcomes. Automatic
DCR, CIMD publication, arbitrary OAuth grant types, shared accounts across plugins, OIDC login,
multi-tenant ownership and multi-process refresh locks are separate work. This restricted
profile must be named in compatibility reports; it is not universal MCP OAuth conformance.

## Search and fixed upstream evidence

Searches on 2026-09-23 included GitHub queries `repo:modelcontextprotocol/typescript-sdk oauth`,
`repo:modelcontextprotocol/typescript-sdk is:issue is:open oauth`,
`repo:panva/oauth4webapi is:issue is:open`, and official-source queries for MCP authorization,
OAuth issuer validation, PKCE, revocation, GitHub remote MCP host integration and Google Drive
MCP configuration. Source, test trees, release records and licenses were actually read.
No accounts, applications or grants were created. Provider documentation is dated evidence,
not a successful connection to either provider.

| Candidate | Exact version and primary evidence | Maintenance, tests, license | Decision |
| --- | --- | --- | --- |
| MCP authorization | [2025-11-25 at `a597fef9805e07a217f45645a830964728276226`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/a597fef9805e07a217f45645a830964728276226/docs/specification/2025-11-25/basic/authorization.mdx) | The repository license records Apache-2.0/MIT transition for specification contributions; other documentation CC-BY-4.0. A specification is not an account store or a tested client. | Use the HTTP authorization roles and discovery/resource requirements; document the initial restricted profile. |
| Existing MCP SDK | [`1.30.0`, `2d889f2b329e46680ec9bdd565de4616c497825a`](https://github.com/modelcontextprotocol/typescript-sdk/tree/2d889f2b329e46680ec9bdd565de4616c497825a); [release, 2026-07-27](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.30.0) | MIT. Inspected `src/client/auth.ts`, `streamableHttp.ts`, `src/shared/auth.ts`, server auth router/provider and `test/client/auth.test.ts`, `auth-extensions.test.ts`. Tests cover PKCE, resource parameters, refresh, discovery and client authentication. | Selected for MCP and token protocol operations; application policy must wrap it. No major SDK migration in P2. |
| OAuth client primitives | [`oauth4webapi 3.8.8`, `916b97952dbf431d8b72f369840de54f5a286e4d`](https://github.com/panva/oauth4webapi/tree/916b97952dbf431d8b72f369840de54f5a286e4d); [release, 2026-09-05](https://github.com/panva/oauth4webapi/releases/tag/v3.8.8) | MIT, Node 20 baseline and Web APIs. Inspected `src/index.ts`, `test/revocation.test.ts`, `discovery.test.ts`, `authorization_code.test.ts`, package scripts and license. Revocation tests cover invalid endpoint/token, extra parameters, status/error handling; discovery tests reject another issuer. Open-issue query returned zero at review time, not a guarantee of no defects. | Selected only for missing response-validation/revocation primitives, with the same bounded custom fetch. Do not replace all MCP auth with another stack. |
| OpenBot adapters | `820d17d`: `plugin-store.ts`, `plugin-service.ts`, `plugin-transport.ts`, `plugin-routes.ts`, `owner-auth.ts`, `app.ts` | Existing encrypted atomic file store, grant/revision checks, receipts, transport bounds and Owner session tests. Single-process serialization only. | Reuse these authorities; add connection state and lifecycle coordination, not another independent permission system. |

Standards reviewed: [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html) for PKCE;
[RFC 8414 §3.3](https://www.rfc-editor.org/rfc/rfc8414.html#section-3.3) for issuer validation;
[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html) for resource metadata;
[RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html) for resource indicators;
[RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html) for authorization-response issuer;
[RFC 9700 §§4.4, 4.14](https://www.rfc-editor.org/rfc/rfc9700.html) for mix-up and refresh protection;
[RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html) for token revocation;
[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html) for native-app redirect boundaries;
and [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591.html) for DCR. These fixed RFCs are standards
references under IETF terms; no RFC code or prose is incorporated. OAuth 2.1 referenced by the
selected MCP edition is draft `-13`, not a finalized RFC.

Upstream issue review found open [SDK #2510](https://github.com/modelcontextprotocol/typescript-sdk/issues/2510)
(mid-session reauthorization dead end; reported against 1.25.3) and
[#2784](https://github.com/modelcontextprotocol/typescript-sdk/issues/2784) (resource/issuer host
confusion during discovery fallback). These motivate local regression cases, not an assertion
that every report reproduces on 1.30.0. SDK server
[#2773](https://github.com/modelcontextprotocol/typescript-sdk/issues/2773) also reports missing
state on error redirects: never accept an unbound error callback to accommodate a provider.

## What SDK 1.30.0 actually does

The following are source observations, not inferred from the MCP specification:

| Public capability | Verified behavior | Required OpenBot wrapper |
| --- | --- | --- |
| `OAuthClientProvider` | Application implements state, verifier, token, client-information and discovery storage hooks. `auth` takes an authorization code, but no callback state or issuer parameter. | Bind a transaction to Owner session, plugin revision, issuer, resource, redirect, client and reviewed scopes. Validate callback before exchange. Never share provider instances across connections/transactions. |
| Discovery | `discoverOAuthServerInfo` catches resource-discovery errors and can fall back to the resource origin as issuer; it selects the first advertised AS. AS metadata is schema parsed without comparing `issuer` with the requested issuer. | Require valid resource metadata and a selected, configured issuer. Validate exact issuer equality and each endpoint before saving discovery or sending credentials. Do not use legacy fallback after a failed security check. |
| URL and PKCE schemas | `SafeUrlSchema` rejects several dangerous schemes but is not an HTTPS/SSRF policy. `startAuthorization` rejects an advertised list without S256, but accepts an absent PKCE-method list. | Require HTTPS, explicit S256 capability and code response type. Only exact, fixture-owned loopback URLs get test exceptions. |
| Resource and scopes | Without resource metadata, `auth` can omit `resource`; normal validation permits a resource path prefix. Absent explicit scopes it can request the advertised list. | Pin one canonical resource in the profile and pass it on authorization, exchange and refresh. Reject changed resource/issuer. Explicitly review requested scopes; a challenge can request consent but cannot expand grants automatically. |
| Exchange and refresh | Public helpers send form requests and parse token responses. Refresh preserves the old refresh token if the response omits one. The higher-level `auth` can invalidate credentials and retry, or fall back to interactive authorization. | Use `auth` only to start a validated, preregistered interactive flow without existing tokens; complete with single-attempt `exchangeAuthorization`. Background refresh calls `refreshAuthorization` directly, never opens a browser and never retries an ambiguous rotation. |
| HTTP transport | Auth-enabled `send` can call `auth`, then recursively `send(message)` after 401 or insufficient-scope 403. | Do not attach `authProvider` to the production effect transport. Refresh before admission; return a stable reauthorization status after a failed request. |
| Revocation | Client `auth.ts` exports no revoke operation. The server-side `OAuthServerProvider.revokeToken` and `revocationHandler` are different APIs. `terminateSession` sends MCP DELETE, not OAuth revocation. | Use the selected RFC 7009 client primitives, or a separately reviewed provider-specific revocation API. Distinguish local disconnect, remote acknowledgement and unknown outcome. |

A read-only Node probe against the installed 1.30.0 public APIs used an in-memory `fetchFn` and
synthetic metadata. It returned `mismatchedIssuerAccepted: true`,
`plaintextTokenEndpointAccepted: true`, `missingPkceMetadataAccepted: true` and
`clientRevocationExports: []`. No network request or token exchange occurred. This directly
confirms the need for policy validation rather than assuming the SDK enforces the full profile.

`oauth4webapi.validateAuthResponse` verifies state and an advertised/returned `iss`, rejects
duplicate parameters it reads and rejects implicit/hybrid responses. OpenBot must still require
exactly one bounded code **or** error, reject duplicate security parameters and require `iss`
support for the first generic profile. Its errors can include response parameters; map them to
fixed diagnostic codes instead of logging thrown objects. Its revocation custom fetch is not
SSRF protection by itself. No `skipStateCheck` or general insecure-request option in production.

## Existing OpenBot integration constraints

`plugin-transport.ts` pins DNS resolution, rejects private targets and redirects, limits request
and response sizes, and supplies the bearer token itself. Its fetch only admits the configured
MCP endpoint; it rejects 401/403 before returning a response and does not expose
`WWW-Authenticate`. Passing an SDK auth provider into this fetch therefore cannot add OAuth.
Add a separate, bounded discovery path that reads only relevant challenge fields from a benign
initialization probe; never send a tool call to discover authorization. Reuse address validation
and pinned HTTP/TLS mechanics without broadening the normal MCP endpoint allowlist.

`FilePluginStore` encrypts state with AES-256-GCM and writes atomically with private file/key
permissions. Add optional, strictly parsed OAuth connection records to this same state and retain
existing bearer installations. Keep the current aggregate size limit; give tokens, metadata,
accounts and pending work explicit bounds. `publicPlugin` currently removes only `token` and
spreads the remaining record: change it to an explicit public projection before adding secrets.
Missing keys, failed encryption or invalid records must block use, not reset to empty state.

`PluginService` already uses plugin revisions, manifest digests, Bot grants, in-flight aborts and
durable call receipts. A connection has a separate credential generation for ordinary refresh
and an identity/authority revision for reconnect, scope change or disconnect. Bind dispatch to
both plugin and connection revisions; rotate tokens without invalidating unchanged grants.
Reconnect/account replacement invalidates pending approvals and clears grants for fresh review.
Generic OAuth does not identify a person: show a connection label and issuer, not an invented
verified email. A verified provider account ID requires a provider profile or validated OIDC
flow, neither implicit in an opaque access token.

[ADR-0007](../decisions/0007-local-owner-auth.md) and
[ADR-0016](../decisions/0016-control-plane-web-security.md) require Owner sessions, strict cookies
and exact mutation Origins. Cross-site callbacks cannot rely on that Strict cookie. Keep the
cookie policy. Add only a named callback route outside the default `/api/v1/*` authentication
gate; it must not return account data or authorize a connection by itself. The existing
`OwnerAuthService.authenticate` exposes Owner identity but no private session binding, so add a
Server-only binding helper rather than sending a cookie or its digest to the UI.
[ADR-0045](../decisions/0045-capability-lease-protocol.md) defers OAuth for capability leases;
this proposal is an outbound MCP client and does not introduce a new Server login or lease AS.

## Minimal lifecycle and fail-closed storage

1. **Begin:** authenticated, Origin-checked Owner POST selects a configured profile and plugin
   revision. Create 256-bit state plus SDK PKCE verifier, bind the current private session, exact
   issuer/resource/client/redirect/scopes, and return the SDK authorization URL. No model or
   Provider may initiate or complete consent. Defaults: at most 16 pending flows, 10-minute TTL,
   one flow per connection, no caller-provided return URL. Replacing a flow destroys its verifier.
2. **Callback and completion:** validate bounded query, state, issuer and the exact callback
   profile. Atomically move the transaction to `callback_received` and retain its code only in
   bounded Server memory. Return a fixed same-origin completion destination with an opaque flow
   ID, never code/state/token. An authenticated, Origin-checked completion POST from the original
   still-valid Owner session claims the transaction once before exchanging. Logout, a different
   session, duplicate callback, expired state or changed revision produces zero token requests.
   Denial is terminal only when correctly bound. Callback responses use no-store/no-referrer;
   logs, traces and reverse-proxy instructions exclude query/body credentials.
3. **Commit:** validate token type, finite positive bounded expiry, scope and token sizes; store
   absolute expiry with a small refresh safety margin. Persist encrypted credentials and the
   bound identity revision atomically before marking connected. Storage failure never returns
   connected. A token response lost before persistence is unknown, not retried; start new
   consent. An installation still needs preview, declaration acceptance, enablement and Bot grants.
4. **Refresh:** one in-flight refresh per connection and generation, with bounded removable
   waiters and one deadline. Persist a refresh-intent marker before the HTTP request; commit
   rotated credentials and clear the marker in the same atomic write. A missing replacement
   refresh token retains the previous one only on a successful, valid response. Do not hold the
   store serialization queue across network I/O. Compare connection revision/generation again
   before saving; a late response cannot resurrect a disconnected account. A timed-out/lost
   response, `invalid_grant`, failed persistence or an unfinished intent on restart means
   `reauthorization_required`, with zero replay of that refresh token. Late results are fenced.
5. **Use:** check connection state and expiry before the existing call-admission/receipt boundary,
   then recheck authority immediately before dispatch. Cancellation removes only its own refresh
   waiter; shared refresh work remains deadline-bounded. A 401/403 after dispatch updates a safe
   connection diagnostic and ends that invocation. Subsequent Owner consent cannot retry it.
6. **Disconnect:** durably mark locally disconnected, advance revision and abort/fence pending
   work before remote revocation. A write failure is a failure, not a successful disconnect.
   An already dispatched external effect may still complete; retain the real receipt state.
   If a reviewed revocation endpoint exists, move credentials into a sealed, non-dispatchable
   revocation record and make one bounded RFC 7009 attempt. HTTP 200 means provider acknowledged
   token revocation, not proof of whole-account grant deletion. Then erase credentials. A timeout
   or crash leaves `remote_revocation_unknown`; an explicit Owner retry uses only that record.
   No endpoint means local disconnection with remote revocation unavailable and secret deletion.
   Never present either outcome as remotely revoked. Provider-specific wider revocation requires
   a separate, accurately described action.
7. **Restart:** load connected credentials only with the matching key and schema. Pending
   authorization transactions are intentionally memory-only and expire on restart; the Owner
   starts again. Durable refresh intents become reauthorization-required, and unfinished remote
   revocations remain locally blocked. Old call receipts remain terminal/unknown as designed.
   None of these records makes the file store safe for multiple Server writers.

## Discovery and network policy

Preregistered profile selection is the first implementation boundary. The profile contains the
approved resource, issuer, client registration and exact Server callback URL; external providers
are disabled until configured. Discover with SDK helpers through an operation-specific fetch,
then validate before caching. Respect safe `WWW-Authenticate` metadata locations and both
resource well-known forms; require RFC 8414 or OIDC metadata with exact issuer and S256 support.
Do not infer endpoints from the MCP host after discovery fails. Changing any bound endpoint,
client or resource invalidates the cached profile and requires review.

Each metadata, token and revoke URL is independently validated. HTTPS, no userinfo/fragment,
bounded URLs/JSON/challenges, bounded DNS answers and response bodies, a finite deadline,
DNS-to-connection pinning, TLS hostname verification, no redirect following and no compression
surprises remain mandatory. Public HTTPS alone does not authorize sending a stored client
secret to a newly advertised host. Fix allowed endpoints for each reviewed issuer profile;
refresh and revoke use that binding, not new data from a hostile MCP response. Never forward a
resource bearer token to discovery or AS endpoints. A fixture gets only its exact owned
loopback URLs and random ports, never a process-wide network-policy bypass.

DCR is deferred, not silently attempted when client credentials are missing. An untrusted
`registration_endpoint` creates both SSRF and credential-substitution risks, while remote
`client_uri`, `logo_uri`, `jwks_uri` and CIMD documents can trigger additional fetches. Adding DCR
later requires per-issuer registration storage, bounded registration/metadata fetches and
explicit trust review. Missing preregistration currently yields `client_configuration_required`.
Missing/mismatched issuer or resource yields `incompatible_authorization_server`, never fallback.

## Controlled local fixture and acceptance

Reuse the existing SDK server `mcpAuthRouter`, `mcpAuthMetadataRouter`,
`OAuthServerProvider` interface and Streamable HTTP MCP server. A tiny synthetic provider owns
preregistered clients, one-use codes, rotating token generations and test counters. It is only a
fixture: no production AS is added. Keep SDK PKCE validation enabled. Add explicit `iss` metadata
and responses in the fixture, including error responses; the stock router/provider interface
does not supply OpenBot's account lifecycle automatically. Use two independently bound AS
origins and a resource origin to exercise mix-up and resource separation.

Run through the real Server routes, Owner session store, encrypted plugin store and production
plugin connector against disposable PostgreSQL; follow real HTTP redirects without visiting
an external account. Use synthetic scopes and deterministic read/effect tools with request
counters. Reuse existing smoke ownership/cleanup helpers. No private `.env`, real API token,
paid model or network-wide process cleanup is needed. HTTP tests explicitly omit the Owner
cookie on the callback and require it at completion. A later UI slice must additionally verify
a real browser cross-site return; ports alone do not make two origins cross-site.

| Acceptance case | Observable requirement |
| --- | --- |
| Connect and retain | One authorization-code exchange; state/verifier never public; credentials encrypted; restart preserves a connected grant and only an authorized Bot can use its reviewed tool. |
| Consent and callback rejection | Deny, missing/wrong/replayed state, duplicate code/error, wrong/missing issuer, wrong callback, expired/logged-out/different Owner session, removed plugin or changed revision: zero exchanges and zero tool calls. |
| Discovery attacks | Issuer mismatch, wrong resource, absent S256, private/mixed DNS, changed endpoint, redirect, oversized or non-JSON metadata, unrelated AS fallback: no credential request; unrelated fixture sink receives zero secrets. |
| Scope/account changes | Challenge cannot silently expand scopes. Reconnect requires fresh grant review; bearer installations remain readable and unrelated plugins retain their grants. |
| Rotation and concurrency | Concurrent callers cause one refresh; new generation is persisted atomically. Omitted replacement token follows SDK semantics. Abort removes waiters; expired/invalid/lost responses and crash after rotation require reauthorization without token reuse. |
| Disconnect races | Disconnect versus queued call, refresh and late callback remains locally blocked; storage failure is surfaced; restart cannot use quarantined credentials. Remote success, unsupported endpoint and dropped response are distinct. |
| No replay | AS expiry/401/403 or dropped MCP response after one side effect leaves exactly one effect attempt. Reconnect, refresh, Server restart and receipt inspection do not add another attempt. |
| Secret and resource hygiene | Public snapshots, API responses, errors and logs contain no token/code/verifier/secret. Missing key and malformed encrypted state fail closed. All fixture ports, containers, owned children and temp secret files are cleaned on success, timeout and interruption. |

The required evidence is a saved scenario report with non-skipped failure cases and request
counts, plus existing plugin/auth regressions. Passing it permits only a controlled-fixture
claim until an actual provider's metadata, scopes, redirects, account constraints and P1 MCP
profile also pass. This research has not run that unimplemented suite.

## Independent implementation slices

| Slice | Proposed file boundary | Exit criterion |
| --- | --- | --- |
| P2a protocol/policy adapter | New `apps/server/src/plugin-oauth-client.ts`, `plugin-oauth-http.ts`, tests and fixture under `apps/server/src/__fixtures__/`; a narrowly shared transport helper only if extraction preserves current tests | SDK public APIs plus selected response/revocation primitives behind strict profile and fetch; issuer/resource/SSRF/replay negative tests pass. |
| P2b account lifecycle and routes | New `plugin-oauth-service.ts`, `plugin-oauth-routes.ts`; scoped changes in `plugin-store.ts`, `plugin-service.ts`, `plugin-routes.ts`, `owner-auth.ts`, `app.ts`, `packages/protocol/src/plugins.ts` and tests | Real Owner flow, encrypted restart, refresh intent/singleflight, disconnect, existing grants and receipts pass the required fixture journey. |
| P2c Owner UI and provider validation | Existing shared client plugin panel/API and bilingual `PLUGINS` docs; dedicated provider profile tests | Connect/status/reauthorize/disconnect states and cross-site browser return work; selected external provider tested only with supplied configuration and authorization. |

P2a and P2b together are the minimum useful local-fixture deliverable; an adapter alone does not
complete the feature. The integrator owns manifest/lockfile wiring for the proposed dependency,
test commands/CI evidence, reuse ledger and roadmap. Do not alter capability leases, introduce
new login identities, refactor all transports or change global cookie policy in this work.

## GitHub and Google Drive: explicit provider boundaries

**GitHub remote MCP.** The [official host guide, pinned at
`85598ba6e1256f7ebf4867b95d63b833c4549264`](https://github.com/github/github-mcp-server/blob/85598ba6e1256f7ebf4867b95d63b833c4549264/docs/host-integration.md)
says hosts obtain GitHub tokens and DCR is unavailable. Choose a GitHub App or OAuth App owned
by the deployer, establish account/organization access and use the actual MCP challenge rather
than guessing an issuer. This is a documented GitHub-specific token contract, not permission
to pass arbitrary third-party tokens through other MCP servers. The local stdio server's
built-in OAuth app is a different integration and cannot be borrowed for the HTTP plugin.

[GitHub's current OAuth flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
supports S256 and recommends state; the Server must use its own registered exact callback,
with wildcard matching disabled. Keep client secrets on the self-hosted Server; never ship a
shared secret in Electron or a public web bundle. Distinguish cloud GitHub from Enterprise
hosts. [Expiring GitHub App user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
can have refresh tokens; do not invent refresh tokens for an ordinary OAuth App response.
[GitHub revocation](https://docs.github.com/en/rest/apps/oauth-applications) uses its own REST
operations, and deleting a grant affects the application's user grant, not just this connection.
That needs a provider adapter and an accurate Owner action, not an assumed RFC 7009 endpoint.

**Google Drive remote MCP.** Google now documents an official
[`https://drivemcp.googleapis.com/mcp/v1` service](https://developers.google.com/workspace/drive/api/reference/mcp).
The [setup guide, updated 2026-09-18](https://developers.google.com/workspace/drive/api/guides/configure-mcp-server)
still marks Developer Preview and requires program membership, a Cloud project, Drive and Drive
MCP APIs, an OAuth consent configuration and a web-application client. Its examples name
`drive.readonly` and `drive.file`; their combination must not be silently requested for every
task. Register OpenBot's own Server callback, not the Antigravity or Claude URLs in the examples.
The actual service challenge/metadata and OpenBot's restricted MCP profile remain untested.

[Drive scope documentation](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
distinguishes per-file `drive.file` from restricted whole-Drive read scopes. A read-only label
does not make whole-Drive metadata/content access a low-scope grant. Choose whether the first
task reads selected files or searches existing Drive contents. Account, organization and
publication/verification requirements depend on that choice. The service also
[filters ineligible files](https://developers.google.com/workspace/drive/api/guides/drive-mcp-server-file-eligibility)
based on permissions, IRM/DLP, context-aware access and encryption; successful login does not
mean every file visible in the Drive UI is available through MCP.

[Google's web-server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server)
needs `access_type=offline` for unattended refresh, a provider extension not equivalent to the
SDK's `offline_access` scope. Google documents project-wide consequences for revocation; do not
label it as removing only one plugin. [External apps in Testing](https://developers.google.com/identity/protocols/oauth2)
can receive refresh tokens expiring after seven days, subject to the documented basic-profile
exception. Account policy or revoked grants can also require new consent.

If the official Drive preview is unavailable, using another MCP operator requires reviewing
that operator and its OAuth/resource contract. Building a Drive API plugin is a different
adapter: its Google API credentials and the OpenBot-to-MCP credential must not be conflated.
This proposal does not add that adapter or request service-account/domain-wide delegation.

For either provider, the default architecture is a Server-side web OAuth client at an exact
HTTPS public callback. Local development uses an explicitly registered loopback callback only
where the provider supports it. A remote Server cannot receive a callback sent to the user's
unrelated laptop loopback. Desktop merely opens the external browser; an embedded public
native-client design needs a separate RFC 8252 profile and must not pretend to protect a
bundled client secret. Without `iss` support, a provider requires a reviewed alternate mix-up
defense, such as distinct issuer callbacks under RFC 9700; do not weaken the generic profile.

## Minimum user input and remaining uncertainty

No input is needed to implement the controlled fixture. Before a real provider connection,
ask only for (1) GitHub or Google Drive and the first concrete read-only task/account scope,
and (2) local-only versus hosted Server with its callback origin. Then inspect whether the
deployer has an appropriate app/project and required organization/preview access. Request
client credentials through a secure Server configuration path when that path exists, not in
chat. App registration, consent and wider provider revocation remain explicit external actions.

Remote metadata/issuer behavior, refresh availability, provider account identity, actual callback
compatibility and tool-profile compatibility remain unverified. No claim of either provider's
production support follows from this research. Planned state names and numerical bounds above
are design decisions, not existing behavior.

## Source incorporation and verification record

No upstream source or documentation text was copied or substantially adapted. The plan calls
published APIs through normal dependencies; preserve their MIT notices through existing
dependency distribution. If fixture source is later copied from an upstream example, record
the exact file and preserve that source's notice in the implementation change.

Completed here: repository/source/release/test/issue/license review and the installed-SDK
synthetic probe described above. This change contains only this research and its Chinese
translation. It does not register clients, install a new dependency, alter CI, migrate state,
exercise personal accounts or claim that the proposed lifecycle has already passed acceptance.

Documentation validation passed: `npm run docs:check` (361 Markdown files) and
`npm run research:check` (17 checker tests). The PR-body CLI correctly did not run outside a
pull-request event. These checks validate the research handoff, not an OAuth implementation.
