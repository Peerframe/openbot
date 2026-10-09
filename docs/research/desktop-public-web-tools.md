# Research: Public web tools in the installed Desktop Agent

- Status: Accepted
- Date: 2026-09-08
- Owner: OpenBot contributors
- Acceptance journey: The installed Desktop's existing ops Agent searches a public query without a supplied URL, reads a source, and returns evidence with an observed tool completion.
- Security boundary: Server-owned native Agent claims, settings revisions, cancellation and audit remain authoritative. Search credentials go only to fixed official endpoints. Public page reading reuses the existing DNS-pinned HTTPS reader. No browser session, login, shell or external messaging authority is added.

## Search evidence

- GitHub queries: `vercel/ai moonshotai tool reasoning_content`, `vercel/ai ToolLoopAgent`, `MoonshotAI web_search`.
- Primary documentation: [AI SDK ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent), [Kimi official tools](https://platform.kimi.com/docs/guide/use-official-tools), and [Tavily search](https://docs.tavily.com/documentation/api-reference/endpoint/search), reviewed 2026-09-08.
- Existing ledger: native Agent loop, Kimi Desktop model, native research/artifacts, Desktop model presets. Rechecked installed SDK source, licenses and tool/reasoning continuation tests; upstream issue [17798](https://github.com/vercel/ai/issues/17798) documents provider capability/version assumptions.
- Root checkout commit `9cc73c9e78451e572f57d142d6b9caf62ccb78e2` contains a separately reviewed search adapter, but its model runner is not the Desktop runner. Installed Desktop source baseline is `cca7f36`. Its native tool table has no search and its system instruction denies every URL absent from the current message.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Existing AI SDK native loop | ai 7.0.93 / `6359fd58fe68eaade096b5d923bac26de84ca3bd`; @ai-sdk/moonshotai 3.0.45 / `8a09c78c039e2c092468eaeff97faaabf3b77366` | Apache-2.0 | Released source and existing provider continuation tests; issues reviewed above | Preserves existing Desktop identity, memory, skills and usage accounting | Reuse |
| Kimi Formula search | v1 hosted contract observed 2026-09-08; `moonshot/web-search:latest` | Hosted API; no distributed source | Official schema and previously observed live Formula execution | Existing selected official Kimi key; encrypted output must stay with that Kimi model | Thin adapter |
| Tavily search | Hosted API contract observed 2026-09-08 | Hosted API; no distributed source | Official bounded search schema | Separate explicit retrieval key; plaintext evidence usable by other chat providers | Optional shared backend |
| Existing public source reader | OpenBot `cca7f36`; html-to-text 10.0.1; ipaddr.js 2.5.0 | MIT | Existing private-address, redirect, DNS and output tests | Credential-free public HTTPS, pinned numeric address and TLS identity | Reuse for source reading |

## Reuse decision

- Extend the existing ToolLoopAgent tool table and completion allowlist, not the other branch's model/storage architecture. No new dependency.
- Use an explicit Tavily key when configured; otherwise only the selected official Kimi connection may execute Kimi Formula search. Never send another provider's key or Kimi ciphertext across providers, or guess another stored account.
- Add public URL reading through the existing reader. Retain the old indexed explicit-source tool for existing tasks.
- Four web calls within the existing eight-tool, five-model-step, 90-second Run budget. Search transport is bounded to 256 KiB; opaque Kimi evidence is bounded to 100,000 characters and 128 KiB serialized so ciphertext is never truncated. Other tools retain their existing 16 KiB result limit. Existing model response and token budgets still apply.
- Record content-free started/completed/failed progress around web effects after fresh scope/settings checks. Audit failure before execution prevents the request. Tool failures fail the Run, rather than silently substituting old model knowledge.
- Retrieval instructions state current availability and supersede earlier no-internet replies. Public source URLs do not require individual grants. Search results remain untrusted evidence.
- Mutable hosted Formula tags are not immutable releases. Maintain fixed reviewed names and local schemas; re-review contract changes. No universal live-provider claim.

## Source incorporation

- No external upstream source copied or substantially adapted. Adapt the existing OpenBot Formula wire contract and reuse existing released SDK/reader implementations. Existing notices remain packaged.

## Verification plan

- Native SDK no-URL search continuation, source reading, audit-before-effects, revocation, four-call limits, malformed/oversized responses, aborts and cross-provider credential isolation.
- Full `npm run check` in the Desktop source worktree, rebuild/package, verify installed runtime contents and signature, preserve the existing user profile, then exercise a synthetic public search through the installed Agent code.
- Bilingual research and user-facing documentation; document real installed evidence separately from mocks. macOS arm64 only for local package verification.

## Unresolved questions

- Non-Kimi chat models need an explicitly configured plaintext retrieval service. This repair does not infer a retrieval account from an unrelated model key.

## Verification outcome

- Desktop-source `npm run check` passed on macOS arm64. Server: 339 passed, 26 existing database integration cases skipped without a configured test database; Desktop: 202 passed; Web: 138 passed. The 31 search-adapter tests include cancellation during a stalled response body. The existing indexed reader also shares the four-call web budget, with regression coverage.
- The first restricted run could not bind loopback WebSockets (`EPERM`); the complete check passed with local listening permitted. Packaging similarly required network access for the exact-pinned Electron runtime.
- Rebuilt and installed the existing OpenBot application on this Mac. The package and installed bundle both passed `codesign --verify --deep --strict` (development signature; no notarization claim). Installed `native-agent.js` SHA-256: `38088146f25a61e444645580cecdd393abe702baaa00c2a197ba9ab3a79e2dc1`; `native-web-tools.js`: `86637ed27a9212f863e121c0729ac73dfe33250243d5f044c39d8245908bacbc`.
- Encrypted model-settings and bootstrap file digests matched before and after replacement; the existing workspace reopened. No new credential or data migration was needed.
- A synthetic public NVIDIA specification search was submitted through the installed UI to the existing Agent, without a supplied URL or channel-history read. The durable inspector showed `Started web_search` at 20:20:18, `Completed web_search` at 20:20:20, and completed at 20:20:27 (Asia/Shanghai). The selected model remained `moonshot / kimi-k3`, with two steps and reported 3,762 input / 179 output tokens. The final reply included the official NVIDIA source URL.
- This demonstrates one real installed Kimi search continuation and durable tool progress, not live acceptance for other model accounts or verification of current retailer prices. Private transcripts, credentials and screenshots are not included in this record.
