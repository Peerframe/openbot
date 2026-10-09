# Research: Owner-configured model services and provider presets

- Status: Accepted
- Date: 2026-09-08
- Owner: @yxflc11
- Related issue: User-requested common model and popular API-provider configuration in this workspace.
- Acceptance journey: An authenticated Owner selects a provider preset, saves an API key, selects
  or enters a model, and assigns it to a new or existing model Employee. A queued Run retains its
  selected connection and model even if the Employee is subsequently changed.
- Security boundary: The Server owns connection endpoints, credentials, Employee binding, Runs,
  and audit. This remains bounded text chat; models gain no tools, memory access, or computer authority.

## Search evidence

- Search date: 2026-09-08. This is an interoperability survey, not a popularity ranking.
- GitHub queries: `openai/openai-node releases chat completions`,
  `anthropics/anthropic-sdk-typescript releases messages models`,
  `anomalyco/opencode custom provider baseURL models`, and `npm/write-file-atomic v8.0.0`.
- Primary API documents were checked for endpoints, model IDs, model discovery, regions,
  authentication, and reasoning/output differences:

| Provider | Reviewed official API base URLs | Model/discovery decision | Primary evidence |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | GPT-5.6 Terra/Sol/Luna suggestions; Chat Completions and models list | [Models](https://developers.openai.com/api/docs/models), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [List](https://platform.openai.com/docs/api-reference/models) |
| Anthropic | `https://api.anthropic.com` | Sonnet 5, Opus 5, Haiku 4.5; native Messages and models list | [Models](https://platform.claude.com/docs/en/models/overview), [List](https://platform.claude.com/docs/en/api/models/list) |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | Gemini 3.8 Flash/3.5 Flash Lite; documented beta compatibility API | [Compatibility](https://ai.google.dev/gemini-api/docs/openai), [Models](https://ai.google.dev/gemini-api/docs/models) |
| DeepSeek | `https://api.deepseek.com` | V4 Flash/Pro; Chat Completions and models list | [Quickstart](https://api-docs.deepseek.com/), [Chat](https://api-docs.deepseek.com/api/create-chat-completion/), [List](https://api-docs.deepseek.com/api/list-models/) |
| Kimi | `https://api.moonshot.cn/v1`, `https://api.moonshot.ai/v1` | K2.6/K3/K2.7 Code; retain the existing legacy K3 environment default | [Models](https://platform.kimi.ai/docs/models), [K3](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart), [Thinking](https://platform.kimi.ai/docs/guide/use-thinking-models), [List](https://platform.kimi.ai/docs/api/list-models) |
| OpenRouter | `https://openrouter.ai/api/v1` | Discover model IDs; do not silently select an automatic/free router | [Quickstart](https://openrouter.ai/docs/quickstart), [List](https://openrouter.ai/docs/api/api-reference/models/get-models) |
| SiliconFlow | `https://api.siliconflow.cn/v1`, `https://api.siliconflow.com/v1` | Separate regions; text/chat-filtered discovery; preserve slash-containing IDs | [CN quickstart](https://docs.siliconflow.cn/docs/userguide/quickstart), [List](https://docs.siliconflow.com/en/api-reference/models/get-model-list), [Catalog](https://www.siliconflow.cn/models) |
| Alibaba Cloud Model Studio | `https://dashscope.aliyuncs.com/compatible-mode/v1`, `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, `https://dashscope-us.aliyuncs.com/compatible-mode/v1` | Region-specific keys; Qwen 3.8 Max suggestion and manual IDs. Native discovery has a different endpoint/schema, so do not assume OpenAI models-list compatibility | [Compatibility and domain migration](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope), [Native list](https://help.aliyun.com/zh/model-studio/list-models) |
| Zhipu / Z.AI | `https://open.bigmodel.cn/api/paas/v4`, `https://api.z.ai/api/paas/v4` | GLM-5.3/GLM-4.7-Flash suggestions and manual IDs; no verified compatible list endpoint | [CN models](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2), [Chat](https://docs.z.ai/api-reference/llm/chat-completion) |
| MiniMax | `https://api.minimax.cn/v1`, `https://api.minimax.io/v1` | M3/M2.7; split reasoning from visible content | [CN compatibility](https://platform.minimaxi.com/docs/api-reference/text-openai-api), [Global](https://platform.minimax.io/docs/api-reference/text-openai-api), [List](https://platform.minimax.io/docs/api-reference/models/openai/list-models) |

- Volcengine Ark uses `https://ark.cn-beijing.volces.com/api/v3`, confirmed in the
  [official runtime constants](https://github.com/volcengine/volcengine-python-sdk/blob/5.0.48/volcenginesdkarkruntime/_constants.py)
  and release `5.0.48` (2026-09-03). Its preset requires an explicitly entered account
  inference-endpoint/model ID; no compatible model-discovery or fixed model default is claimed.
- The Model Studio documentation says existing DashScope domains remain usable during migration
  to workspace-specific MaaS domains. Coding/Token Plan endpoints are separate products and are
  not silently substituted for these standard API routes.
- Existing reuse entries checked: Server model chat (`kimi-model-chat.md`), PostgreSQL stores,
  Owner profile revision checks, atomic sensitive files, and POSIX credential permission drift.
- Reviewed SDK issues: OpenAI [#1825](https://github.com/openai/openai-node/issues/1825) and
  [#2153](https://github.com/openai/openai-node/issues/2153) timeout behavior; Anthropic
  [#1170](https://github.com/anthropics/anthropic-sdk-typescript/issues/1170) streaming-body retries
  and [#1162](https://github.com/anthropics/anthropic-sdk-typescript/issues/1162) schema helpers.
  The chosen slice uses JSON text requests, no streaming upload, no schema helper, no retries,
  and an explicit total deadline and response-byte limit.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| OpenAI Node SDK | `7.10.0`, `c22b09bc8bd5feed4ebd02b9f363a1a8b479b5ab` | Apache-2.0 | Existing reviewed pinned dependency; client/resources, cancellation, response-timeout and retry tests | Node 22+ matches; injectable fetch, explicit endpoints, bounded text transport | Reuse for documented compatible APIs |
| Anthropic TypeScript SDK | `0.124.0`, `ba14b1f4fdf2e840a7b32297965342a099f6201d` | MIT | Released 2026-09-04; reviewed client, Messages, Models, abort/timeout/retry tests and open issues | Node 20+/TS 5+ fits; native Messages blocks/system format differs from OpenAI | Add exact-pinned released dependency |
| OpenRouter TypeScript SDK | `v1.2.107` | Apache-2.0 | Released 2026-09-05; unit/e2e tests; issues #852 (examples), #693 (reasoning parameters), #519 (debug option) inspected | ESM fits but current text API is already covered by the existing SDK | No additional dependency |
| DashScope Python SDK | `v1.27.3` | Apache-2.0; existing certifi MPL-2.0 notices | Released 2026-09-01; maintained tests and broad deployment/training APIs | Python and control-plane scope are unnecessary for this Node text adapter | Use documented compatibility API |
| Volcengine Python SDK | `5.0.48` | Apache-2.0 Ark runtime with OpenAI attribution | Released 2026-09-03; runtime constants/source and release inspected | API-key text compatibility fits; AK/SK management authority is outside scope | Reuse API contract; no source copied |
| GCM authenticated encryption | NIST SP 800-38D (2007), Node `crypto` public API documented in `v26.8.1` | Open standard; Node MIT runtime | Standard authenticated encryption implemented by the existing Node/OpenSSL runtime | 256-bit random key, fresh 96-bit nonce, 128-bit tag, connection-bound AAD | Use the standard runtime implementation; no local cipher implementation |
| Protected credential files | Existing OpenSSH review `1bf5871aead6d73177d727add15ab0f14c258fdf`; `write-file-atomic@8.0.0` | BSD-style reference; ISC dependency | Existing file handle/type/permission/size tests and reviewed atomic write/cleanup source | Local Server key file, POSIX 0600, exclusive initialization; not a native keyring | Reuse established file-permission boundary for the encryption key |
| OpenCode configurable providers | [Official provider documentation](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/providers.mdx), observed 2026-09-08 | Reference only; no code incorporated | Maintained provider configuration and custom-ID documentation | Confirms preset plus explicit endpoint/model configuration UX; its authority/runtime is not adopted | Product reference only |

SDK source/tests: [Anthropic pinned tree](https://github.com/anthropics/anthropic-sdk-typescript/tree/ba14b1f4fdf2e840a7b32297965342a099f6201d),
[OpenAI pinned tree](https://github.com/openai/openai-node/tree/c22b09bc8bd5feed4ebd02b9f363a1a8b479b5ab).
Anthropic's [release](https://github.com/anthropics/anthropic-sdk-typescript/releases/tag/sdk-v0.124.0),
[client](https://github.com/anthropics/anthropic-sdk-typescript/blob/ba14b1f4fdf2e840a7b32297965342a099f6201d/src/client.ts),
[Messages tests](https://github.com/anthropics/anthropic-sdk-typescript/blob/ba14b1f4fdf2e840a7b32297965342a099f6201d/tests/api-resources/messages/messages.test.ts),
[Models tests](https://github.com/anthropics/anthropic-sdk-typescript/blob/ba14b1f4fdf2e840a7b32297965342a099f6201d/tests/api-resources/models.test.ts),
and [MIT license](https://github.com/anthropics/anthropic-sdk-typescript/blob/ba14b1f4fdf2e840a7b32297965342a099f6201d/LICENSE)
were inspected at that pin.
Encryption sources: [NIST](https://csrc.nist.gov/pubs/sp/800/38/d/final),
[Node crypto](https://nodejs.org/api/crypto.html#cryptocreatecipherivalgorithm-key-iv-options),
[Node file handles](https://nodejs.org/api/fs.html#fspromisesopenpath-flags-mode).

## Reuse decision

- Selected option: documented compatibility APIs and released SDKs behind thin text adapters.
  Compatibility APIs are not described as an independent open standard.
- Why first viable: the existing SDK already supports most reviewed providers; a second native
  SDK handles Anthropic without implementing a competing wire client or adding an agent framework.
- Exact local gap: provider presets, bounded model discovery with manual entry, Owner create/update/disable operations,
  encrypted connection credentials, Employee binding, immutable Run selection, and content-free audit.
- Connection protocol, provider, and endpoint are immutable after creation. Key rotation and
  enable/disable are revision checked. Changing an endpoint requires a new connection, preventing
  queued Runs from silently changing destination. Missing/disabled connections never fall back.
- Presets permit only exact reviewed URLs. Custom compatible endpoints require an explicit exact
  Server operator allowlist; arbitrary browser input cannot direct Server credentials to a new host.
  No URL userinfo/query/fragment, HTTP endpoint, or redirect is accepted.
- API keys are authenticated-encrypted in PostgreSQL with AAD binding the connection ID/provider/
  endpoint. The separate local key is never exported; loss of that key fails closed. Connection
  changes and content-free audit are committed in one database transaction. The automatically
  initialized POSIX `0600` key file defaults to `./data/model-credentials.key` through
  `OPENBOT_MODEL_CREDENTIAL_KEY_PATH`; operators must back it up with PostgreSQL. If any saved
  connection exists, missing-key startup refuses to generate a replacement.
- Legacy `MOONSHOT_*` remains a Server-only fallback for pre-existing unbound model Employees;
  environment keys are not copied into the connection store. Employee packages do not export
  local bindings or credentials.
- Model IDs remain open to manual entry, including `/`, `:` and provider prefixes. Model discovery
  is a bounded list operation, not a claim that every listed model supports text chat or that a
  key has paid inference access. Discovery reads one SDK page, caps the response at 2 MiB, and
  returns at most 256 IDs. OpenRouter uses `GET /models?output_modalities=text`; SiliconFlow uses
  `GET /models?type=text&sub_type=chat`. A separate explicit test call checks text inference and
  may incur charges; saving a connection never runs that test.
- Parameter adapters omit unsupported sampling/reasoning knobs. OpenAI and Kimi K3 use
  `max_completion_tokens`; K3 uses `reasoning_effort: low` by default, while the legacy environment
  adapter retains its configured effort. Other compatible adapters use the reviewed `max_tokens`
  field; MiniMax requests `reasoning_split: true` and rejects mixed `<think>` output. Anthropic
  uses native Messages, top-level `system`, required `max_tokens`, and visible text blocks only.
  Its explicit `authToken: null` prevents ambient bearer credentials from following a saved Key.
  Chat response bytes remain capped at 256 KiB; redirects, automatic retries, tool output,
  nontext output, and incomplete replies are rejected. Private reasoning is never rendered or persisted.
- Exit plan: update pinned SDKs and data-only provider entries after review; retain ModelClient,
  Server authority, and portable Employee contracts. Native keyring/KMS can replace the key adapter.

## Source incorporation

- Source copied or substantially adapted: no.
- Files and upstream locations: installed SDK dependencies only; local policy/configuration code
  calls their public APIs and Node crypto. No upstream agent runtime is embedded.
- Notices: dependency packages retain their Apache-2.0/MIT/ISC notices; the reuse ledger links this review.

## Verification plan

- Automated: provider request shapes, bounded discovery, HTTP auth/Origin gates, credential
  redaction/encryption, Owner revisions, per-Employee selection, immutable queued Run binding,
  existing Kimi compatibility, and full `npm run check`.
- Negative: unknown preset/endpoint, disabled or missing connection, stale revision, lost or
  tampered key/ciphertext, exposed/symlink key file, oversized responses, tool/nontext/truncated
  output, upstream errors, cancellation and deadline. Never echo provider response bodies/keys.
- Database: disposable PostgreSQL migration/store checks for encrypted persistence, audit and
  binding snapshots. UI: preset -> connection -> model selection -> Employee binding at desktop
  and mobile widths, including unavailable discovery and manual IDs.
- Documentation: English and Chinese setup/API/reuse documentation.
- Support level: experimental Server text adapters with contract tests on the observed local
  environment. Live inference is only claimed for providers actually exercised with authorized keys.

## Unresolved questions

- Native tool calling, token streaming, automatic model routing, automatic paid fallback/retries,
  favorites/recent lists, price synchronization, native keyrings, and KMS remain separate work.
