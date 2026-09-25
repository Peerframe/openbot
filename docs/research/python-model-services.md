# Research: Python model settings and provider services

- Date: 2026-09-23
- Status: settings input/preset adapter approved; SDK/storage dependency review in progress.
- Baseline: 5beed49 and existing model-settings.ts/native-agent.ts/model-providers.ts.
- Acceptance: Owner-controlled encrypted settings retain the TS envelope and provider choices;
  the Python host invokes bounded official SDK requests, with no credentials given to the worker.

## Existing contracts and pure adapter decision

Reuse Pydantic 2.13.5 and the existing reviewed Zod 4.6.2 adapter/UUID/ECMAScript trimming rules.
The reuse ledger's model-service-presets, native-agent-loop, OpenRouter, Kimi, Desktop bootstrap
and Python input decisions apply. Preserve all 11 current providers and exact endpoint strings;
no arbitrary URL, redirected credential, renderer-owned endpoint or new default provider.
The original MIT OpenBot schemas/presets are the local source being ported; no external source
is copied. Compare actual compiled TS input and retained schemas before use in encrypted storage.
A model setting is not an execution grant; agentEnabled and activation timestamp remain explicit.
The feature-source per-Bot model connections stay in the S6 preservation scope and must be merged
before final selection; this existing active-settings service is not proof of that later capability.

## Primary documentation consulted

Opened official OpenAI SDK, rate-limit and streaming documentation:
- https://developers.openai.com/api/docs/libraries
- https://developers.openai.com/api/docs/guides/rate-limits
- https://developers.openai.com/api/docs/guides/streaming-responses

The control boundary will explicitly disable SDK automatic retries, enforce an overall request
lifetime/byte cap, keep stored-response and telemetry behavior disabled, and translate only visible
text and explicit function intents. No provider-hosted tool can acquire OpenBot authority.
Before adding SDK or cryptographic dependencies, inspect pinned source/tests/license/issues and
record the exact released choice below. Pure preset/input implementation can proceed independently.

## Released dependency review and decision

| Candidate | Exact release / commit | License | Evidence and fit | Decision |
| --- | --- | --- | --- | --- |
| OpenAI Python SDK | 3.17.0 / 8c72a700d900fb2578227df564a54462abfe67f8 | Apache-2.0 | Python >=3.10; async official Responses/Chat resources; inspected _base_client.py, _streaming.py, test_client.py, release/license and open issues | Reuse released SDK, no local protocol/stream decoder |
| Anthropic Python SDK | 1.8.0 / 4421d56a4dd23550c7097c9b7ab5668bd11e09c4 | MIT | Python >=3.10; native Messages API; inspected client/stream code and tests, license, release and open issues | Reuse released SDK for native Messages |
| PyCA cryptography | 50.0.1 / ffde75a2b594822c740a2e4748b56c00548302bf | Apache-2.0 OR BSD-3-Clause | Python >=3.9; AESGCM implementation and invalid-tag/AAD tests; platform wheels and changelog; authenticated encryption matches retained AES-256-GCM envelope | Reuse released AESGCM; never implement cryptographic primitives locally |
| Additional provider framework | existing PydanticAI 2.47.0 runtime | MIT | Already owns the isolated strategy loop; adding its provider layer in the control package would still require the same official SDKs and add a second history conversion | Keep the existing runtime; use thin official-SDK adapters at the control boundary |

GitHub queries: releases/issues for openai/openai-python, anthropics/anthropic-sdk-python and
pyca/cryptography. Source/tests were fetched from full commits above. OpenAI issues2502/2561/2486
concern typed response completeness/hosted reasoning tools; those tools are outside this adapter.
Anthropic issues1940/1919/1918 expose missing final stop fields and raw/mid-stream errors: inspect
terminal status, reject incomplete output, close the stream and map failures without raw bodies.
No speculative success from a parsed partial result. PyCA50.0.1 uses reviewed wheel builds; no
optional certificate/PKCS7 APIs are used. Upstream licenses remain in installed distributions.

HTTPX2 2.13.0 is the SDK HTTP dependency and was already reviewed/pinned with the runtime. Retain
its version and existing control pins; inspect newly resolved metadata before locking. Use fixed
URLs, TLS verification, trust_env=False, redirects=False and retries0; bound raw response bytes
and total lifetime before SDK consumption. HTTP client injection is trusted composition for test
fixtures, not a public arbitrary endpoint. Test real SDK resource requests with synthetic transport
responses, and loopback integration through owned fixtures. No real model credential is required
or read for development. No external source is copied or patched.

## Settings persistence and authorization design

Preserve version1 envelope/AAD openbot.model-settings/v1, 12-byte nonce, 16-byte tag, ciphertext,
existing revision/agentEnabledAt and key semantics. POSIX reference only: trusted private directory,
no symlink traversal, owner-only permissions, regular bounded files, atomic replace+fsync. Windows
ACL/native-host support is not inferred from this port. Storage uncertainty is not automatically
retried. Explicit configuration only; no inherited dotenv or read of private existing settings.
Metadata verification precedes write; optimistic revision recheck occurs at commit under a local
file lease. Public mutation must authenticate before credential transmission, retain Owner authority
through the final publication boundary, and expose neither apiKey nor provider response bodies.
Shared-file safety requires explicit single-writer selection; a filesystem lease is not a migration
permission to concurrently run the legacy writer. Per-Bot/model connections remain separately tracked.


The dry-run resolver preserves all 23 existing pins and adds11 distributions: openai3.17.0,
anthropic1.8.0, cryptography50.0.1, httpx2/httpcore2 2.13.0, truststore0.10.4,
cffi2.1.1(MIT-0), pycparser3.0(BSD-3-Clause), jiter0.17.0(MIT),
docstring_parser0.18.0(MIT), sniffio1.3.1(MIT OR Apache-2.0).
Exact PyPI wheel metadata requires Python3.12-compatible versions; native wheels are selected,
no source compiler/install script or global interpreter update. The complete resolved closure is
pinned in requirements.lock. Optional cloud/realtime/audio/SSH SDK extras are not installed.
