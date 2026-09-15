# Research: AI SDK provider patches, September 15

[English](ai-sdk-patches-september15.md) · [简体中文](ai-sdk-patches-september15.zh-CN.md)

- Status: Reviewed; final integration checks required before merge
- Date: 2026-09-15
- Owner: OpenBot contributors
- Related PRs: [#82](https://github.com/Peerframe/openbot/pull/82), [#83](https://github.com/Peerframe/openbot/pull/83)
- Acceptance journey: Existing Moonshot and Anthropic native Agent requests, tool feedback,
  bounded output and failure handling continue to work after the reviewed provider patches.
- Security boundary: Server owns identity, credentials, endpoint policy, tool scope, cancellation,
  approval and audit. Provider responses and private reasoning remain untrusted model data.

## Search evidence

Reviewed the [reuse ledger](../OPEN_SOURCE_REUSE.md), [native Agent review](native-agent-loop.md),
[Kimi integration review](kimi-desktop-model.md), and the current `apps/server/src/native-agent.ts`
adapter and contract tests before accepting these existing dependency upgrades.

Searches on 2026-09-15: GitHub `repo:vercel/ai is:issue is:open anthropic`,
`repo:vercel/ai is:issue is:open moonshot`, and exact release tag searches for
`@ai-sdk/anthropic@4.0.53` and `@ai-sdk/moonshotai@3.0.49`. Primary documentation reviewed:
[Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic) and
[Moonshot provider](https://ai-sdk.dev/providers/ai-sdk-providers/moonshotai).

The [Anthropic release](https://github.com/vercel/ai/releases/tag/%40ai-sdk%2Fanthropic%404.0.53)
and [Moonshot release](https://github.com/vercel/ai/releases/tag/%40ai-sdk%2Fmoonshotai%403.0.49)
were published on 2026-09-11. Both GitHub tags resolve to
`9ed46d2da5df1394079c66d422bc553fd0c34376`. Read the package manifests, changelogs, provider
factories, relevant language-model implementation and tests at that commit; source links below
are immutable. Read the upstream Apache-2.0 license and both published packages' `LICENSE` files.

## Candidate comparison and exact pins

| Candidate | Exact release and source | License | Maintenance, compatibility and decision |
| --- | --- | --- | --- |
| Existing Moonshot provider | `@ai-sdk/moonshotai` 3.0.45 → 3.0.49; `9ed46d2da5df1394079c66d422bc553fd0c34376` | Apache-2.0 | Maintained release with Node and Edge test scripts; native Kimi reasoning/tool mapping fits the existing adapter. Select the released patch. |
| Existing Anthropic provider | `@ai-sdk/anthropic` 4.0.49 → 4.0.53; same commit | Apache-2.0 | Maintained Messages API provider with language-model, batch and type tests. Select the released patch. |
| Generic OpenAI-compatible mapping | Existing reviewed OpenAI adapter | Apache-2.0 | Does not replace the two providers' native message and reasoning contracts. No reason to migrate providers for this patch review. |
| Local replacement or fork | None selected | None incorporated | No implementation gap requires copied code or a local provider implementation. |

Both npm releases require Node `>=22`, retain provider interface v4, depend on
`@ai-sdk/provider` 4.0.14 and `@ai-sdk/provider-utils` 5.0.40, and accept Zod
`^3.25.76 || ^4.1.8`. These requirements fit OpenBot's Node 22 runtime, AI SDK 7 and Zod 4
line; dependency resolution and contract tests remain acceptance checks.

Read the exact [Anthropic npm metadata](https://registry.npmjs.org/@ai-sdk%2fanthropic/4.0.53)
and [Moonshot npm metadata](https://registry.npmjs.org/@ai-sdk%2fmoonshotai/3.0.49).
Downloaded the official tarballs without installing or executing them; independently recomputed
SHA-512 and verified it against npm metadata and the corresponding Dependabot lock entries:

```text
@ai-sdk/anthropic 4.0.53
sha512-JMxAuCFte6mFOvoaUcig3Dp2LObin0wU2Li8ncsveh7hHKW7cG3g1bFjooxn1paxeT8UUf5XMSjhxtXG9wFLig==
@ai-sdk/moonshotai 3.0.49
sha512-t/WlDfCelV8jZDv2kjr1C9Begk0rt1apNqSMqzWB+Y76uW3oncOfvZOxkLST8XoGF8a2zv5BVFqtNi+ESYAKoQ==
```

## Changes and risk assessment

Moonshot 3.0.46–48 propagate shared provider updates. Version 3.0.49 includes the
[empty tool-call delta fix](https://github.com/vercel/ai/commit/00968508b7f47e5b1e7faa0bf001c2288abb8098).
The [stream implementation](https://github.com/vercel/ai/blob/9ed46d2da5df1394079c66d422bc553fd0c34376/packages/moonshotai/src/moonshotai-chat-language-model.ts)
now ends reasoning for tool deltas only when the array contains entries. The
[regression test](https://github.com/vercel/ai/blob/9ed46d2da5df1394079c66d422bc553fd0c34376/packages/moonshotai/src/moonshotai-chat-language-model.test.ts)
checks that consecutive reasoning deltas with empty tool arrays share one reasoning lifecycle;
the same file tests raw usage fields and malformed tool indices. This affects a stream path
OpenBot uses, so its Kimi continuation and private-reasoning suppression tests remain required.

Anthropic 4.0.50–53 update batch request model selection, cancellation/listing, unsupported
request rejection, and explicit preserved-thinking binding options. Read the
[language-model implementation](https://github.com/vercel/ai/blob/9ed46d2da5df1394079c66d422bc553fd0c34376/packages/anthropic/src/anthropic-language-model.ts)
and [thinking serialization tests](https://github.com/vercel/ai/blob/9ed46d2da5df1394079c66d422bc553fd0c34376/packages/anthropic/src/anthropic-language-model.test.ts).
The [batch test](https://github.com/vercel/ai/blob/9ed46d2da5df1394079c66d422bc553fd0c34376/packages/anthropic/src/anthropic-batch.test.ts)
asserts unsupported image requests fail before HTTP. OpenBot currently calls the language-model
adapter; it does not enable batches, native compaction or these thinking binding options.
The release's broader batch/image capabilities therefore do not add OpenBot authority.

Both factories retain explicit `apiKey`, `baseURL` and custom `fetch`. OpenBot continues to pass
its configured endpoint and guarded fetch, with automatic retries and telemetry disabled.
Shared provider-utils patches include bounded-memory base64 encoding, improved media detection,
and validated OAuth redirect helpers; the
[OAuth SSRF patch](https://github.com/vercel/ai/commit/c43e4b71387cc4f10ec6ae973e6f441786f6c247)
also changes the separate MCP package. This review does not enable MCP OAuth or claim that a
provider upgrade alone certifies OpenBot network isolation.

Open issues inspected:

- [#13907](https://github.com/vercel/ai/issues/13907): Moonshot cached-token billing through
  AI Gateway. OpenBot's reviewed adapter uses the direct configured provider endpoint.
- [#19632](https://github.com/vercel/ai/issues/19632): cross-provider raw-usage preservation
  audit remains open. Preserve OpenBot's usage tests; do not claim live billing fidelity from
  fixture tests or from this release alone.
- [#13335](https://github.com/vercel/ai/issues/13335): empty Anthropic compaction blocks rejected
  when resent. The report concerns an older provider version and an option OpenBot does not
  enable. It is not evidence this upgrade fixes every compaction case.

## Reuse decision and failure behavior

Selected option: dependency. Keep the existing released providers and thin Server adapter.
The identified integration gap is missing research evidence in automated dependency PRs, not a
missing runtime implementation. Record evidence and validate the combined lockfile without
relaxing the research gate or security tests. If a contract fails, defer or revert the offending
package bump and its lock changes; preserve current fail-closed errors and Owner configuration.

No upstream source copied or substantially adapted. Preserve package `LICENSE` files and the
existing Vercel attribution in `THIRD_PARTY_NOTICES.md`; align listed versions with the final
resolved dependency set. No new platform, live-provider or security support is asserted.

## Verification evidence and acceptance plan

At review time, [#82's original run](https://github.com/Peerframe/openbot/actions/runs/34969569151)
on `9d4fc898c3cf8a6f15e157941a44b09013643e0e` and
[#83's original run](https://github.com/Peerframe/openbot/actions/runs/34969632041)
on `964cf1c11ba761e0d31cc3e34e930bf032e64d72` each have eight successful jobs. Both logs identify
the missing `Open-source research` PR section; `validate` fails and the aggregate `check`
therefore fails. This is not evidence of a new provider execution failure.

The upstream tests above were read, not executed in this review. Tarball checksum and license
checks were executed. No provider credentials, paid requests or user transcripts were used.
Before merge, the final integration commit must pass clean dependency installation,
`npm run check`, security audit, three portable platforms, Windows Worker Host build,
database checks and both Server container architectures. Current-head results must replace
the original runs as merge evidence. Maintain this Chinese translation in the same change.
