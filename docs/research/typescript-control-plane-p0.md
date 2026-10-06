# TypeScript control plane: P0 review and baseline

English · [简体中文](typescript-control-plane-p0.zh-CN.md)

- Status: P0 accepted; dependency choices reviewed, native and GUI baselines measured
- Date/search date: 2026-10-06
- Owner: @yxflc11
- Decision: [ADR-0050](../decisions/0050-typescript-control-plane.md)
- Related: [PR #192](https://github.com/Peerframe/openbot/pull/192)
- Trigger: material architecture and future dependency/runtime changes
- Acceptance journey: preserve Web/Desktop/API/data/recovery while retiring Python
- Security boundary: Server-owned sessions, grants, budgets, audit and effect admission;
  Temporal owns continuation; clients, model output and executor reports remain untrusted.

## Existing decisions and search evidence

Reviewed the relevant [reuse ledger](../OPEN_SOURCE_REUSE.md) entries for PostgreSQL migration,
Zod, Desktop packaging, Python control/runtime, provider transport and Temporal. Preserve
[ADR-0046](../decisions/0046-temporal-as-recovery-owner.md)'s authority/recovery split.
The changed assumption is the Owner's one-language and final Python-retirement requirement.

P0 measurement checkout: `codex/c22-c24-storage-follow-ups`,
`010439bb9002fabb7e1facd8450ee85edbafa309`, with pre-existing uncommitted changes.
The #192 files are merged upstream but absent from this checkout; the ADR references their fixed
PR head instead of pulling over unrelated edits. Current source inventory: 173 control modules /
31,743 physical lines; `packages/harness` adds 13 modules / 3,476 lines. These include working-tree
changes and are not a refreshed estimate of #192's dated area percentages.

Read actual `packages/db` driver/migrator, protocol rules, Python route registrations,
Work contract generator/Web conformance entry, harness rules, native launcher/controller and
installed Desktop provenance. At P0 the contract generator started Python to export Work OpenAPI.
The existing schema/migrations and parsers are reusable; not every public contract is yet TS-owned.

GitHub/primary searches: `fastify/fastify releases v5`, `honojs/hono releases`,
`temporalio/sdk-typescript releases`; pinned package/source files and release APIs for those
repositories plus `openai/openai-node`, `anthropics/anthropic-sdk-typescript`,
`porsager/postgres` and `brianc/node-postgres`. Issue queries:
`repo:fastify/fastify is:issue is:open stream`,
`repo:honojs/hono is:issue is:open stream`,
`repo:temporalio/sdk-typescript is:issue is:open replay` and `... electron`.
Zero Electron search results are not support evidence. Read the official Fastify validation/server
and Temporal TypeScript testing guides; decisions below reference fixed source where available.

## Candidate comparison and dependency map

Versions are the exact **reviewed candidates**. At P0 none were installed; P2 now installs the selected
Fastify/reply-from pair and patches one retained MCP transitive dependency. Provider/Temporal
targets remain pending their applicable phases.
Public APIs are reused; application authority still requires OpenBot's existing guards and tests.

| Responsibility/current Python pin | TS candidate / reviewed source | License | Fit, maintenance and decision |
| --- | --- | --- | --- |
| HTTP: FastAPI 0.141.1, Starlette 1.6.0, Uvicorn 0.53.0 | [Fastify 5.12.5 / ba235fd](https://github.com/fastify/fastify/tree/ba235fdcd9a83a4c7ccf793f7b2596a8f65389b6) | MIT | Select Node lifecycle, explicit limits/hooks and streaming. [Release](https://github.com/fastify/fastify/releases/tag/v5.12.5) includes a content-type security fix; reviewed stream tests and validation docs. Strict Zod and existing errors override coercion/default behavior. |
| HTTP alternative | [Hono 4.13.13](https://github.com/honojs/hono/tree/v4.13.13) | MIT | Maintained Web-standard API and familiar historic fixtures. Reviewed release/package and streaming issue search; Node serving needs an adapter. Viable, but Fastify fits the required Node lifecycle directly; reject for this proposal. The oracle is not revived. |
| DB: psycopg 3.3.6 | Existing [Postgres.js 3.4.9](https://github.com/porsager/postgres/tree/v3.4.9) + [Drizzle 0.45.2 / e7dfa145](https://github.com/drizzle-team/drizzle-orm/tree/e7dfa14519f363229ccc3ead7b1b2f2051937efb) | Unlicense; Apache-2.0 | Select existing production DB/migration adapter and reviewed transaction semantics. Real PostgreSQL lock/CAS/audit tests remain required; an ORM port is not proof of SQL equivalence. |
| DB alternative | [node-postgres pg 8.23.1 / 0980cefe](https://github.com/brianc/node-postgres/tree/0980cefebe0ae461da8883703be049fe13ca96cf) | MIT | Maintained pooled driver; package test entry reviewed. Viable, but introduces driver/pool/type/cancellation changes alongside the port; no current driver gap justifies it. |
| Public DTOs: Pydantic 2.13.5 | Existing [Zod 4.6.2 / e359f737](https://github.com/colinhacks/zod/tree/e359f7378fe56d695134701cda1e9055a08892dc) | MIT | Select current shared contract package. Reuse prior input review; preserve missing/null, unknown fields, bounds and normalization through Python/TS negative fixtures. |
| OpenAI: openai 3.17.0 | [openai 7.28.0 / fb695562](https://github.com/openai/openai-node/tree/fb6955621e1cf6653659adb75094ebace83ebfe9) | Apache-2.0 | Official SDK, released 2026-10-04; reviewed package/README. Node >=22, transport/streaming tools and explicit cancellation/retry settings; select transport only. |
| Anthropic: anthropic 1.8.0 | [@anthropic-ai/sdk 0.131.0 / d49bdab4](https://github.com/anthropics/anthropic-sdk-typescript/tree/d49bdab458000bcdffe77bd84b03293f31824fb3) | MIT | Official core SDK release `sdk-v0.131.0`, 2026-09-30; reviewed package, README and client. Do not confuse the repository's latest Google Cloud SDK tag with the core SDK. Select transport only. |
| Recovery: temporalio 1.33.0 | [@temporalio/{client,worker,workflow,activity,common,testing} 1.24.0 / 1fd1c81](https://github.com/temporalio/sdk-typescript/tree/1fd1c81a0383f5f5c7923dd735472c7d1ffdc867) | MIT | Official released SDK; reviewed requirements, license and replay test source. Keep genuine supported Node 20/22/24; remote Activities and drained Python histories are default. Production/testing packages keep separate closures. |
| Strategy: pydantic-ai-slim 2.47.0, pydantic-graph 2.47.0 | Official transports above + port of existing bounded harness contracts | Upstream licenses above; OpenBot MIT | SDK calls do not implement the current strategy/receipts/approval semantics. P4 must port the real consumers and qualify their failure paths; no new autonomous scheduler. |
| Strategy alternative | Existing [AI SDK 7.0.93 / 6359fd58](https://github.com/vercel/ai/tree/6359fd58) | Apache-2.0 | Prior repository review remains relevant. Shared model abstractions are useful, but do not by themselves replace current Pydantic message receipts, control fences or granular durable checkpoints. Do not add this higher-level runtime automatically. |

Selected SDK source reads show two default retries and long default transport deadlines. Configure
explicit deadlines/cancellation and no hidden transport retries where control/Temporal owns retry or
the outcome is uncertain. Imported tool schemas cannot become Fastify-generated executable code.
[Fastify's pinned validation guide](https://github.com/fastify/fastify/blob/v5.12.5/docs/Reference/Validation-and-Serialization.md)
describes coercion/compiler behavior; use the current strict protocol validators rather than stripping
extra fields or silently coercing input.

Upstream test/source reviewed:
[Fastify stream tests](https://github.com/fastify/fastify/blob/v5.12.5/test/stream.1.test.js),
[Temporal replay/flags](https://github.com/temporalio/sdk-typescript/blob/v1.24.0/packages/test/src/test-integration-replay-and-flags.ts),
[OpenAI retry/timeout contracts](https://github.com/openai/openai-node/blob/v7.28.0/README.md),
[Anthropic client](https://github.com/anthropics/anthropic-sdk-typescript/blob/sdk-v0.131.0/src/client.ts).
These upstream suites were **not executed** in P0.

Relevant open reports on the search date:
[Fastify stream/Buffer typing #7009](https://github.com/fastify/fastify/issues/7009),
[Hono HTTP/2 adapter streaming #4041](https://github.com/honojs/hono/issues/4041),
[Temporal concurrent local-activity replay #2455](https://github.com/temporalio/sdk-typescript/issues/2455),
[Temporal Node 26 determinism #2269](https://github.com/temporalio/sdk-typescript/issues/2269).
Keep remote Activities and a supported Node LTS target; pinning alone does not prove product replay,
streaming or security. The [Worker runtime requirements](https://github.com/temporalio/sdk-typescript/blob/v1.24.0/README.md)
do not qualify Electron as a replacement Node runtime.

Auxiliary map: keep existing reviewed `jose 6.2.12`, `canonicalize 5.0.0`, `yaml 2.9.0`,
MCP `@modelcontextprotocol/sdk 1.30.0`, wire and parser adapters as candidates for their current
Python JOSE/JCS/YAML/MCP/WebSocket paths. The Python JSON Schema dialect/ref bounds and
BeautifulSoup/SoupSieve HTML extraction still need consumer-specific equivalence review before
P3/P4 selects replacements. They are identified gaps, not missing functionality to skip.
Provider API compatibility beyond official OpenAI/Anthropic also needs fixture-by-fixture validation.
Do not claim this core comparison fully qualifies every future TS dependency.

## Reuse and source incorporation

Select released dependencies and thin adapters over a new web framework, database driver or durable
scheduler. The local gaps are complete shared contract fixtures, private forwarding/ownership and
the bounded TS strategy port. They end at group retirement; the temporary Python forwarding path
must disappear in P5. Unavailable upstreams fail closed; there is no alternate authority.

No upstream implementation is copied or substantially adapted. Source and tests were read as
evidence; P0/P1 added no runtime dependencies. Preserve new transitive/native notices and
separate production/test package closures when installing the selected pins.

## P2 forwarding adapter review (2026-10-06)

Searches: `repo:fastify/fastify-http-proxy is:issue is:open websocket`, official proxy/reply-from
releases/security advisories, fixed source/test/package files and Node22 HTTP upgrade/stream APIs.
The proxy search returned0 open matches; that does not prove complete WebSocket support.

| Candidate | Fixed source/license | Decision and concrete gap |
| --- | --- | --- |
| `@fastify/http-proxy`11.6.4 | [1bf6131](https://github.com/fastify/fastify-http-proxy/tree/1bf6131e1967afc783eb92d402af8a9af79e6afd), MIT; released2026-10-04 | Maintained Fastify5 integration with raw payload streaming and HTTP/WS prefix security fixes. Its query rewrite normalizes query bytes; WS messages wait on the outgoing connection and call `send` without stream backpressure. Default integration does not meet the exact-query/bounded-queue gate. |
| `@fastify/reply-from`12.6.5 | [5422fd6](https://github.com/fastify/fastify-reply-from/tree/5422fd681132d53a7f058b8b4f55e49ff5345dc3), MIT | Select its released HTTP adapter under the approved Fastify5.12.5 pin. Source accepts raw body streams, preserves untouched query search and copies response headers/streams. Fixed connection-header and aborted-request tests are present. OpenBot owns only fixed-target/route admission, bounded lifecycle and sanitized transport failures. |
| Retained Desktop proxy | Existing source and C19/Desktop decision | Keep its renderer role. It supplies Desktop credentials and bounded fetch projections; it is not the product HTTP/Worker transport or another authority. |

Reviewed proxy11.6.0 as the prior security floor, then fixed11.6.4. The
[prefix-escape advisory](https://github.com/fastify/fastify-http-proxy/security/advisories/GHSA-7hrw-592w-9wh2)
requires11.6.0 or later. Source/release review is not a production advisory scan; installation still
requires exact lockfile resolution, notices, `npm audit --omit=dev --audit-level=high` and focused gates.
P2 now installs Fastify5.12.5/reply-from12.6.5 in the exact workspace lockfile; no upstream
implementation is copied/adapted. The production audit exited0 at the high threshold with0
high/critical and2 moderate entries: fast-uri and retained ip-address. This is not a clean audit
claim; no unrelated dependency upgrade was applied.

Reply-from defaults to GET503 retries; setting `maxRetriesOn503:0` alone is ineffective because the
reviewed implementation uses a falsy default. Configure `retryMethods:[]`, `retriesCount:0` and an
explicit retry callback returning `null`; test dispatch counts for503/socket-loss and mutation failure.
Use a raw stream parser so invalid JSON and integer-token spelling reach the existing Python
authorization/body parser unchanged. Do not parse/re-encode forwarded JSON or add identity headers.

For `/ws/nodes`, prefer a narrow raw upgrade/duplex-stream adapter using
[Node22.23.2 HTTP APIs](https://github.com/nodejs/node/blob/v22.23.2/doc/api/http.md) and
[stream backpressure](https://nodejs.org/docs/latest-v22.x/api/stream.html#readablepipedestination-options).
It must preserve handshake/frame bytes and close/error/abort, limit pre-handshake lifetime, stream
through a fixed target with bounded buffering and never reconnect automatically. This is an API-based
integration, not a new WebSocket protocol implementation. Its actual qualification is pending.

Critical prerequisite: real `serve.py` does not expose trusted proxy peer configuration although
the retained Worker route has an explicit one-proxy identity policy. Reject caller-supplied forwarding/
identity metadata. Qualify direct peer/rate-limit preservation through the existing policy before
claiming an externally bound mixed service. A first local candidate must enforce its loopback scope;
it cannot silently claim public deployments. Retain one Python background writer/migrator until an
accepted group switch. The forwarding adapter exits in P5.

P2 peer composition reuses C19's exact single-hop RFC7239 boundary. Only an explicitly configured
numeric loopback peer may enter the private Python listener; that listener must bind127.0.0.1.
An ASGI adapter validates one bounded `Forwarded` value with the retained resolver and supplies the
resolved client address to existing login throttling. Node enrollment retains the private forwarded
source/digest through an internal scope value. Public scheme/Host come from a fixed operator origin,
never a caller header. TS rejects inbound forwarding/identity headers and derives `for` from its
direct socket peer. Missing/malformed metadata, an unexpected private peer or partial configuration
fails closed. Uvicorn's general proxy-header interpretation remains disabled. This adds no identity,
session authority, database writer or persistent schema; the direct Python composition is unchanged.

Native P2 composition extends the reviewed Desktop Python launcher/parent-pipe supervision and
production lock graph. Keep one PostgreSQL supervisor and one existing guarded migrator; launch
Python on a separate private port with the same bootstrap/key/object roots, then TS on the public
port. A strict installed-resource marker chooses this composition before launch. Missing/malformed
TS resources cannot silently fall back. Both children own inherited parent pipes; either child's
terminal event stops the pair, and normal shutdown closes TS before Python before PostgreSQL.
Use the retained standalone Node24.21.0 runtime during coexistence; Electron ABI/extra-Node removal
belongs P4/P5. A distinct TS Preview identity/profile/output protects canonical/Python installations.
This reuses fixed trusted app resources and existing configuration formats; it adds no renderer
command, database format, service registration, dependency or copied upstream source.
Lifetime behavior follows the reviewed [Node24.21.0 child-process API](https://github.com/nodejs/node/blob/v24.21.0/doc/api/child_process.md)
and [Fastify5.12.5 server close API](https://github.com/fastify/fastify/blob/v5.12.5/docs/Reference/Server.md).

## Actual baseline

Measured the installed **OpenBot 0.1.0-alpha.9**, macOS 27.0.1 / build 26A434, arm64.
Its source commit is not embedded: identity is the ASAR, requirements and harness wheel SHA-256
in the [sanitized raw observations](typescript-control-plane-baseline.json). Its `serve.py` hash
differs from the working tree; this is intentionally an installed-version baseline.

Extracted its ASAR into a disposable directory, imported its unchanged compiled
`NativeServerController` and `launchPythonProductServer`, and ran them with the installed
Node 24.21.0 / CPython 3.12.13 / PostgreSQL 17.10 payload. Only disposable private profiles/databases
were used; the synthetic encryption callbacks copy the repository smoke fixture's convention,
so this does not test macOS Keychain. No dotenv, existing profile, credentials or paid provider was
used. No Temporal configuration was supplied: this is the supported API-only composition.

| Metric | Observed |
| --- | ---: |
| Fresh-profile ready: initdb + PostgreSQL + migrations/preflight + Python HTTP + Owner login | 4,954 ms median; 4,897–5,594 ms, n=3 |
| Existing disposable-profile restart to the same ready condition | 3,992 ms median; 3,966–4,003 ms, n=3 |
| Python launch/preflight/migration/health substep, fresh / restart | 3,879 / 3,688 ms median |
| Native child-process RSS, fresh / restart | 166.00 / 161.83 MiB median |
| Python process RSS, fresh / restart | 117.38 / 117.34 MiB median |
| Installed app regular-file bytes, excluding symlinks | 1,211,381,873 (1.128 GiB) |
| Native payload regular-file bytes | 766,100,210 (730.61 MiB) |
| CPython / extra Node / PostgreSQL bytes | 256,379,737 / 196,895,972 / 135,051,359 |
| Reference ZIP of that same bundle | 467,530,551 bytes (445.87 MiB) |
| Reference UDZO DMG, same bundle plus Applications link | 653,513,894 bytes (623.24 MiB); checksum verified |

RSS is the sum of descendants' RSS, excluding the measurement controller and its `ps` sampler;
shared PostgreSQL pages can be counted more than once. It is not physical footprint, peak memory,
the Electron process total, or active Work/Temporal usage. Three samples per run were taken after
two seconds idle, at 500 ms intervals; the raw JSON retains all 18 samples. Fresh profile means
fresh data, **not** a cold OS file cache. Same machine/background load/runtime and scope are required
for future comparisons. No percent improvement is claimed.

The ZIP and DMG are locally generated measurement references, not signed/notarized release
installers. DMG SHA-256:
`042ce41132fbd35d9c1ac74ebc9644cf741434e7b15ab785c792c2b0a760efa6`.
They were not installed or published. Temporary profiles, extracted sources and large reference
artifacts are cleaned after observations are recorded.

## Reproduction and limits

From a locked checkout, choose the installed bundle using `OPENBOT_BASELINE_APP`.
Extract using the already installed `@electron/asar` library into `p0_root`; save the measurement
snippet below as `measure.mjs` there. Run the bundled Node, passing extracted app, native payload
and output JSON as positional arguments. Do not use a user's existing data directory:

```sh
OPENBOT_BASELINE_APP="/absolute/path/OpenBot.app"
p0_root="$(mktemp -d "${TMPDIR:-/tmp}/openbot-p0.XXXXXX")"
node --input-type=module - "$OPENBOT_BASELINE_APP" "$p0_root" <<'JS'
import { extractAll } from '@electron/asar';
import { join } from 'node:path';
extractAll(join(process.argv[2], 'Contents/Resources/app.asar'), join(process.argv[3], 'app'));
JS
"$OPENBOT_BASELINE_APP/Contents/Resources/native-runtime/node/bin/node" \
  "$p0_root/measure.mjs" "$p0_root/app" \
  "$OPENBOT_BASELINE_APP/Contents/Resources/native-runtime" "$p0_root/results.json"
```

The reference archive/image commands below use a disposable copy of the same installed bundle.
They do not publish or install it. The byte inventory sums regular files recursively and excludes
symbolic links; keep that convention for P5 comparisons.

```sh
ditto -c -k --sequesterRsrc --keepParent "$OPENBOT_BASELINE_APP" "$p0_root/OpenBot-baseline.zip"
mkdir "$p0_root/dmg-root"
cp -c -R "$OPENBOT_BASELINE_APP" "$p0_root/dmg-root/OpenBot.app"
ln -s /Applications "$p0_root/dmg-root/Applications"
hdiutil create -quiet -volname OpenBot -srcfolder "$p0_root/dmg-root" \
  -format UDZO "$p0_root/OpenBot-baseline.dmg"
hdiutil verify "$p0_root/OpenBot-baseline.dmg"
```

The initial sandboxed launch failed with the launcher's bounded `Native operation failed`
diagnostic and produced no sample. The same disposable command succeeded with local-process
permissions. All six successful starts authenticated, then stopped; the probe confirmed their
health URLs were unreachable and no native descendants remained. This is actual execution,
not cached or simulated timing.

On 2026-10-06 the Owner approved all phases and restarting the running Desktop. The previous
installed Desktop/native processes were confirmed stopped, then the same installed bundle was
launched through CUA. A rendered window was observed at **1,628 ms**, and a connected workspace at
**18,743 ms** (one successful sample, 178 AX observations). The latter required the renderer's
real-time connection state and disappearance of its opening-workspace state. Timing includes
launch/automation/AX overhead; it is an observation bound, not an instrumented first-paint metric.
No messages or mutations were submitted. The installed app was left running; private AX text and
screenshots were not saved to the repository. Active Temporal workload and other platforms remain
phase-specific future qualifications, not passed P0 measurements.

### Measurement snippet

Save as `measure.mjs` before the command above. Its output contains only measurements;
credentials stay in memory and the private temporary profile is removed in `finally`.

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const [appRoot, runtimeRoot, resultPath] = process.argv.slice(2);
assert.ok(appRoot && runtimeRoot && resultPath);
const { NativeServerController } = await import(pathToFileURL(join(appRoot, 'dist/native-server.js')));
const { launchPythonProductServer } = await import(pathToFileURL(join(appRoot, 'dist/python-server.js')));
const root = await realpath(await mkdtemp('/private/tmp/openbot-p0-data-'));
const results = [];
const problems = [];
channel('openbot.desktop.native-startup').subscribe(v => problems.push(v.error?.message ?? 'startup_failed'));
function rss() {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return m && { pid: +m[1], ppid: +m[2], rssKiB: +m[3], name: m[4].split('/').at(-1) };
  }).filter(Boolean);
  const ids = new Set([process.pid]);
  for (let i = 0; i < rows.length; i++) for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid);
  const children = rows.filter(row => row.pid !== process.pid && ids.has(row.pid) && row.name !== 'ps');
  return { nativeChildrenRssKiB: children.reduce((sum, row) => sum + row.rssKiB, 0), pythonRssKiB: children.filter(row => /python/.test(row.name)).reduce((sum, row) => sum + row.rssKiB, 0), controllerRssKiB: rows.find(row => row.pid === process.pid)?.rssKiB, childCount: children.length };
}
try {
  for (let trial = 1; trial <= 3; trial++) {
    let serverMs = 0;
    const login = async (url, password) => {
      const health = await fetch(url + '/health', { signal: AbortSignal.timeout(3000) });
      assert.equal((await health.json()).phase, 'python-product-candidate');
      const response = await fetch(url + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    };
    const controller = new NativeServerController({ runtimeRoot, dataRoot: join(root, String(trial)), platform: process.platform,
      encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(),
      launchServer: async env => { const t = performance.now(); const server = await launchPythonProductServer(runtimeRoot, env); serverMs = performance.now() - t; return server; }, connect: login, authenticate: login });
    try {
      for (const mode of ['fresh-profile', 'restart']) {
        const t = performance.now();
        const state = await controller.start();
        assert.equal(state.status, 'ready', problems.join('; '));
        const readyMs = performance.now() - t;
        await delay(2000);
        const samples = [];
        for (let i = 0; i < 3; i++) { samples.push(rss()); await delay(500); }
        const port = new URL(state.serverUrl).port;
        results.push({ trial, mode, readyMs: Math.round(readyMs), serverMs: Math.round(serverMs), samples });
        await controller.stop();
        await assert.rejects(fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(500) }));
        assert.equal(rss().childCount, 0);
      }
    } finally { await controller.stop(); }
  }
  await writeFile(resultPath, JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, kind: 'installed-desktop-native-controller-api-only', results }, null, 2) + '\n');
  console.log(JSON.stringify(results));
} finally { await rm(root, { recursive: true, force: true }); }
```

## P0 verification before implementation

Executed `npm run docs:check`: exit 0, 12/12 tests, 582 Markdown files checked, no test skips.
Executed `npm run research:check`: exit 0, 27/27 tests, no test skips; the PR-event validation itself
was explicitly skipped outside a `pull_request` event. JSON observation counts/medians and
whitespace checks passed. The pre-existing tracked diff retained SHA-256
`05f77d2bc527a08dd90fc8f33077fee91ea0361ff266c7724f7bb201b62db710`.
These were new local runs, not cached evidence. `npm run check`, product contracts and upstream
suites were not run; no product/script source or dependency was changed. This does not claim a
hosted PR research gate passed.

P1 verifies complete Python public contracts before TS routes exist. P2 verifies private forwarding,
headers/cookies/streams/Worker transport, cold packaging, failure and overhead. P3 verifies each
writer and reverse switch, with identity security review. P4 verifies actual engine/executor recovery,
harness parity and drained histories. P5 verifies the install/CI dependency inventory and final
same-scope resource comparison. See ADR-0050 for the detailed gates and Owner approval boundary.


## Current migration checkpoint (2026-10-07)

Active worktree: `/Users/yxflc/.codex/worktrees/ts-control-plane-p2/openbot`, branch
`codex/ts-control-plane-p2`. Review correction source is
`dc0bf05ad12ac2cea4d4d4a2994c6ab4981143ed`, after integrating accepted main
`3bb6365c660fd40be5dbc181fe1da92093352877` (PR202 SDK repair and Claude PR203 copy).
The catalog conflict retains main's revision3, Chinese name/description and review record;
all five reviewed source fingerprints are identical to the prior migration candidate.
The TS forwarding license rows are retained in the Chinese notices. The original dirty checkout,
installed OpenBot and user profiles remain preserved.

[Claude's whole-interface acceptance](https://github.com/Peerframe/openbot/pull/200#issuecomment-6024172791)
passes at exact source `23a2916d2aa141e1fa4f52391f21b90c2184a520`: Owner sessions, Bot/channel creation,
profile edits, messages/attachments, task submission/cancel, plugins, fifteen settings sections,
SSE disconnect/reconnect and both themes through the TS entry. It excludes paid model replies,
Worker/computer execution, third-party installation and screen-reader qualification. This closes the
missing P2 interface gate; it does not qualify P3 ownership or all future edits.
[CI37514672455](https://github.com/Peerframe/openbot/actions/runs/37514672455) passes all17 required jobs
at that branch source and actual PR merge `2536122d81c390102e60287950cde6d319e7a65a` against main
`8a50575aa89e9c6ab35a6e90440d46a5ac7e4abe`. New correction source requires its own hosted checks.

The review corrections reuse the existing Zod4.6.2 Web projection policy, bounded Owner audit
reader and Python channel-ready lifecycle; no dependency, public route, persistent-data format or
external source is added:

- Web primary-Bot and transcription responses explicitly strip additive fields while strict shared
  Server schemas and strict submitted commands remain unchanged. Known field types still validate.
- Primary-Bot audit titles use existing `from`/`to` detail keys populated from bounded retained Bot
  names, including renamed or tombstoned Bots. This matches ordinary audit subject names, not a
  historic name snapshot. Old/new IDs remain in stored events and export details. Missing subjects
  display an unknown-Bot label; the title never falls back to an internal ID or payload name hint.
- Remove the unsupported `GET /api/v1/runs/{id}/output` Web request. Current Python model transport
  is non-streaming and channel-ready restores committed messages and Run facts. Retain existing SSE
  draft handling without promising recovery of a partial draft that the product never stores.
- Step43 sidebar/crown/avatar animation remains Claude-owned after PR200 merges. The transitional
  primary-Bot dropdown is unchanged.

Focused Web acceptance executes84 tests (Node26.0.0), including additive/invalid responses, rejected
extra command fields, audit titles and reconnect message restoration. The actual mixed
TS→Python→disposable PostgreSQL lifecycle suite executes21 checks under Node22.22.2. The existing
Python/control gate executes1,073 passes/2 optional skips, including the new retained-name and
forged-payload audit regression, CAS/deletion races and rollback. Worker checks are not executed by
this local base command; hosted Worker qualification remains separate.

The current repository check, regenerated consumer inventory, native qualification and hosted CI
results are recorded in the [single current receipt](typescript-control-plane-p2-native.json).
PR200 remains the reviewable P2 candidate. No P3–P5 ownership switch has occurred; the next cohort is
small settings/reads under ADR-0050's actual PostgreSQL, authority and forward/reverse gates.
No provider, registered Worker or system application was added.


Clean source `a8489172` freshly stages and packages the unsigned, uninstalled macOS arm64 candidate
and passes the real packaged startup/restart, paired-exit, parent-EOF and owned-process smoke. The
59 locked Python distributions and pip integrity pass; packaged audit source and revision3 catalog
match the repository, including all five reviewed fingerprints. Actual production Web on the same
packaged TS/Python code and disposable PostgreSQL shows both Bot names at1440×900 and640×900,
with keyboard focus and message/queued-Run restoration after reload. All94 completed API responses
are successful; no Run-output request occurs. Fixtures, browser tab and profiles are removed.

The fresh canonical Electron GUI attempt remains at system credential reading before product
startup and is not acceptance. Menu quit does not finish; all four exact owned PIDs stop with
SIGTERM and its profile is removed. No keychain permission changes. The earlier84184d46 safeStorage
journey keeps its original scope; this run does not replace it or Claude's accepted whole-interface
journey. Current native smoke uses synthetic credential callbacks and does not qualify Keychain.

### Previously qualified P2 integration (before Claude review corrections)

Active worktree: `/Users/yxflc/.codex/worktrees/ts-control-plane-p2/openbot`, branch
`codex/ts-control-plane-p2`; clean product source is
`37e8d7fe65a7b4e588861dee0b2770bdda23e9f0`, integrating accepted main
`8a50575aa89e9c6ab35a6e90440d46a5ac7e4abe` (Claude PR194/PR198 and approved PR201 security repair).
Both UI integrations merged automatically; Codex added no page implementation. The only earlier
conflict was bilingual historical scanner triage: immutable tuples matched and accepted main
records were retained. Original dirty checkout, installed OpenBot and user profiles are preserved.

The SDK audit failure described below is repaired by the reviewed1.32.1 pin. Production npm audit
now reports zero advisories; the two real standalone-starter tests and the oracle guard pass
(all59 frozen source/fixture hashes retained). Only three workspace references and one deduplicated
SDK lock entry change. At SDK code source `10f64b7a`, `npm run check` exits0 and actually executes
protocol461, TS entry33, Web672, Desktop578/3 platform skips and Node129/3 skips. Its tasks/cached
counts are lint10/0, typecheck33/10, test27/12 and build19/12. After PR198 integration, the final
`npm run check` exits0 with Web677 and Desktop578/3 skips actually executed; counts are lint10/10,
typecheck33/30, test27/25 and build19/18. Unchanged tests reuse the SDK-qualified cache.
The catalog-metadata follow-up full check also exits0: lint10/10, typecheck33/33, test27/27,
build19/19 (all Turbo tasks cached). Its actual focused catalog checks pass Python6/1 database
skip, TS2 and real Python HTTP/MCP30; the database-backed publication is exercised by that CLI.

Real SDK-qualified mixed HTTP and verified-CA HTTPS each execute270 integrated plus19 staged
checks, including30 actual MCP checks, current Web/Desktop settings and attachments, persistence,
private Node source/digest, secure cookies and mixed→Python direct→mixed rollback. PR198 changes
no backend or HTTP-consumer code, so those results retain their exact SDK source scope rather
than being reported as repeated executions. Python remains the sole product writer.

The current unsigned, uninstalled full macOS arm64 package keeps the exactly qualified ASAR
`dcbe7010501f5a859a762d4103f10a0c90381fb2dd1a7cac2e7a032b834df692`; its37 Desktop modules and
five renderer files reuse the byte-match proof. App regular files total1,230,254,531 bytes; native
payload783,640,739 bytes. Clean source `37e8d7fe` freshly passes staging, full packaging and lifecycle
smoke; all27,820 native files/32 symlinks match staging and the revised catalog matches repository
bytes. Only reviewed catalog metadata changes from84184d46; implementation, dependencies and
notices are unchanged. The existing companion retains source `6e9d13ed`. CLI Node22.22.2 builds
the Node24.21.0/Python3.12.13 payload, checks59 locked Python distributions and pip integrity.

Actual canonical Electron/native `safeStorage` startup and restart at84184d46 passed in an explicit
owned profile; this unchanged-ASAR GUI evidence is reused, not reported as newly executed. The exact synthetic Bot name, realtime connection and primary-Bot setting restore;
the restored Bot is opened from the sidebar. Model setup is reoffered when no model is configured,
and the existing skip enters the workspace. Initial restart accessibility was empty despite a
visible page; keyboard focus exposed the document and the existing button. This is a narrow
functional observation, not overall accessibility or Claude interface acceptance. Qualified menu
quits both exit0; all13 owned processes per launch and PostgreSQL PID files disappear. Three
private files preserve hashes/0600 and the temporary profile is removed. An earlier welcome-window
launch preceded reported packaging completion and is excluded: only its window closed with the
shortcut, exact owned PID cleanup completed, and no product service had started.

[CI37506404433](https://github.com/Peerframe/openbot/actions/runs/37506404433) completes at branch
9dc564c6 / actual merge1ee8730c against main8a50575a with15 successful jobs and security/aggregate
check failed on the newly ingested old-SDK advisory. Credential and Python audits were skipped;
that run does not qualify the SDK repair. The next CI37511515733 passes security (23 exact
historical findings, npm0 and all58 Python pins audited without advisories/skips), but exposes the
stale catalog hash and one MCP timeout described below. It does not qualify the catalog repair.
At this earlier checkpoint, current-candidate hosted CI was still pending.
[Native receipt](typescript-control-plane-p2-native.json) keeps exact scopes in `currentP2Candidate`
and dated prior entries. [PR200](https://github.com/Peerframe/openbot/pull/200) remains Draft/unmerged.
Claude's P2 whole-interface acceptance was absent at this earlier checkpoint; no P3–P5 ownership switch had occurred.
No provider, registered Worker or system application was added; installed ASAR retains the P0 hash.

### MCP SDK advisory repair (2026-10-07)

Current-candidate [CI37506404433](https://github.com/Peerframe/openbot/actions/runs/37506404433)
failed its production npm audit before credential scanning: locked MCP SDK1.30.0 falls within
[GHSA-6qxp-vccf-f47h](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h),
published to the advisory database on2026-10-06. Earlier main/PR audit0 remains a dated observation.
The current candidate's local history scan at9dc564c6 passes the strict adapter with25 exact
historical findings and no current-commit finding; private output was removed.

Reviewed official npm manifests, source/license, release diffs and accompanying tests for1.31.0
(`4b0051f400219f8d8855f9a5433c6df35f15a639`, first issuer-bound fix) and1.32.1
(`ff07b001194fe60ee9deb2121cf119057565796d`, same MIT/Node>=18/dependency contract).
[1.31 source diff](https://github.com/modelcontextprotocol/typescript-sdk/compare/2d889f2b329e46680ec9bdd565de4616c497825a...4b0051f400219f8d8855f9a5433c6df35f15a639)
includes bounded body/batch reads and issuer-bound saved credentials, with negative tests.
[1.32.1 diff](https://github.com/modelcontextprotocol/typescript-sdk/compare/4b0051f400219f8d8855f9a5433c6df35f15a639...ff07b001194fe60ee9deb2121cf119057565796d)
also defaults HTTP clients to same-origin, method-preserving redirects and fixes experimental
session/task isolation. Select released1.32.1 rather than retaining1.31 or migrating to2.x's split
client/server API. Existing bounded endpoint/session consumers fit the default; no new dependency
kind, auth provider, OAuth credential storage, redirect opt-out or upstream source copy is added.
Reviewed upstream tests are source evidence, not tests executed by OpenBot.

Web's only SDK import is type-only. The example/starter uses MCP Server; the frozen TS comparator
uses its bounded Streamable HTTP client without an OAuth provider. Python owns current product
MCP authority. Thus no persisted OAuth credential conversion is needed for these TS consumers.
The narrowly reviewed oracle exception changes only its devDependency pin: all55 frozen source
files/provenance hashes remain unchanged and the oracle guard/comparators stay required.
Update the two product consumers, comparator metadata, starter's existing pin assertion and
third-party notices together; preserve historical dated SDK reviews. Rebuild and check the real
MCP contract, current dependency audit and native production closure before publishing the repair.

The first repaired-head CI37511515733 passes security but exposes a stale bundled catalog manifest
hash: SDK1.32.1 changes `packages/mcp-example/package.json`. Re-review its five bound files against
exact source `10f64b7a03e24c6b56003dedf5ca051d6458ea64`; only the manifest hash changes. Catalog
revision2 moves source URL/commit and review record together while retaining the four unchanged
source/license/provenance hashes. The initial 2026-10-01 catalog review remains dated evidence.
The same CI has one MCP content timeout; unchanged Node22.22.2 local plugin30 and complete
Python270+19 staged checks both exit0. No timeout, assertion or production transport is weakened;
current-head hosted requalification remains required.

### Preserved earlier integration and hosted receipts

Active implementation is now the managed worktree
`/Users/yxflc/.codex/worktrees/ts-control-plane-p2/openbot`, branch `codex/ts-control-plane-p2`,
based on exact main `a8302c2d7252273ccb292f9fc5202beae4e165b6` ([PR #193](https://github.com/Peerframe/openbot/pull/193)).
The original dirty checkout and its native Preview are preserved. The previously qualified P1/P2
source was based on `010439bb`; its checks, ASAR and performance receipts below remain dated
source-specific evidence and do not qualify this integration.

The candidate mechanically combines the existing migration and C28/C26 changes with accepted
C9/C11/C25 and Claude's interface work. No new page design is in scope. Shared contracts now include
C9's appearance PATCH and C11's optional greeting origin. Published `0052_bot_greeting_origin.sql`
is byte-identical to main; only unpublished C28/C26 additions are renumbered to `0053`/`0054`.
Fresh locked npm/base/Worker environments are local to this worktree. No application was installed
into Applications; the installed OpenBot and user profiles remain unchanged.

The complete source checkpoint is local commit `a240b810ea08bde29004e947b0ffc0298ad8dd1a`
(217 changed files). Read-only GitHub verification then found main's accepted
[dependency patch PR196](https://github.com/Peerframe/openbot/pull/196), merged as
`a544a40d045a1e99e512b3282a8805c7f4ca39e0`. Its automatic integration changes only two existing
lock entries: fast-uri3.1.8 and ip-address10.7.3; proxy-addr2.0.8 already matches. No page or product
source changes. [Consumer-specific review](retained-developer-tools.md#integration-of-accepted-advisory-patches-2026-10-06)
records that the TS native closure includes fast-uri. Its incremental native refresh, packaged smoke
and real TLS contracts have now passed; the dated results below retain their original scope.
The evidence below retains the pre-PR196 dependency scope; it is not relabeled as a new run.
Accepted [C29 planning PR195](https://github.com/Peerframe/openbot/pull/195) is now merged on main
at `2bc698932596698d36e08f20bb4e26e9568b125c` and integrated locally by merge
`8152dd8ac77083b6d86a22913ec86ab1c685f5d6`. Exactly ten documentation/design-record files changed;
product, package, script, CI and contributor-rule paths remain byte-identical to `b466d758`.
C29 remains proposed; this migration does not implement it. This documentation-only integration
passes `docs:check` (12 tests,599 Markdown files) and `research:check` (27 tests); both exit0,
with no test skips. The PR-event check is skipped outside a `pull_request` event. Product source
is unchanged, so the earlier full/native evidence retains its scope without another binary rebuild.
Current native qualification keeps its exact product source `dfc8475f`. Claude's open interface PR194/PR198 and research PR199 do not
supply whole-interface acceptance for this candidate. On2026-10-06 the Owner said “继续执行”
after the prepared branch/Draft PR publication request, authorizing this branch's push and Draft PR
for required GitHub CI. Published [Draft PR #200](https://github.com/Peerframe/openbot/pull/200)
at branch head `49dac0186fa6a127dffc0b079458fca30ac54352` against main `2bc69893`.
Its first [hosted run37470541095](https://github.com/Peerframe/openbot/actions/runs/37470541095)
checks the PR merge checkout `7a16bc1`; the production npm audit has zero findings. The observed
snapshot has11 successful jobs, four failed jobs and one still-running Temporal qualification.
Linux Python/Worker, retained clients/Python Desktop on all three platforms, macOS mixed TS Preview,
Windows Worker build, browser proxy/recovery, synthetic migration, scope and validate passed.
Those hosted build/test lanes retain their declared scope; they do not establish distribution signing,
whole-interface acceptance or P4 TS durable ownership. Whole-interface acceptance remains Claude's
separate gate before a P3 ownership switch.

The initial failures are actual acceptance blockers: the strict scanner rejected five new historical
synthetic URI fixtures; both product-container lanes still read C28's retired singleton-model route;
and installed-harness quality stopped at one unformatted Work fixture. Extending that quality gate
locally then exposed two structural/dynamic typing gaps in the same fixture. The bounded repairs
change only tests, the smoke client, the exact scanner tuple list and these records. Product ownership,
public routes, dependencies and security workflow remain unchanged.

- [Exact scanner triage](credential-scan-fixture-triage.md#ts-contract-and-private-peer-fixtures-2026-10-06)
  retains the pinned full-history scanner, with no verification/upload, broad exclusions or error
  bypass. All26 focused credential/workflow tests pass;27 immutable tuples bind every field, and
  the real23-finding offline result passes. TS entry33, proxy-peer17 and contract-target11 focused
  cases pass. After refreshing all remote history, a local-only temporary commit
  `db804e2d4d1777341d9394bb10722b456c6a1922` containing the candidate repairs returned183 with24
  reviewed historical findings; the strict adapter exits0 and none belongs to that temporary commit.
  The subsequent additions are evidence-only paragraphs; final-head hosted scanning remains required.
- Locked `harness:quality` passes Ruff check/format and real-SDK mypy over24 sources, after correcting
  the fixture to the actual `ReadStore`/`ReadResult` shape and typed Pydantic sample dictionaries.
  The entire fixture JSON is unchanged. `contracts:test` passes1,342 actual DTO/Web cases and15
  client/target cases, with no skips. This is a new run, not relabeled cached parity.
- A fixed-source Linux arm64 product image built from `49dac018` reproduced the old smoke's exact
  HTTP404 at `/api/v1/settings/model`. The repaired client checks its retirement, the current empty
  model-connections list and null transcription selection. Against that same image, real disposable
  container preflight-before-schema refusal, all55 migrations, Owner HTTP/built Web, PDF/DOCX and
  offline OCR initialization, persistent key/files across restart, SIGTERM and owned cleanup pass.
  No model or Temporal is configured. The first local image attempt inherited private clone file
  modes and refused its entry; restoring normal tracked checkout modes changed no source bytes.
  Local macOS Docker arm64 evidence does not replace either hosted Linux platform gate.

The repaired candidate completes `npm run check` with exit0: lint10 tasks/0 cached,
typecheck33/10 cached, test27/12 cached and build19/12 cached. Actual protocol461, TS entry33,
Web676 and Desktop578/3 platform skips rerun; unchanged cache results retain their scope.
Follow-up documentation checks pass12 cases/599 Markdown files and research checks pass27, with
no test skips; the PR-event check remains hosted-only.

The tested repairs are now published as `5ee5b3d72d65a596ea52f85956dc895ef32f60e6` on
[Draft PR #200](https://github.com/Peerframe/openbot/pull/200). Follow-up
[CI run37475123514](https://github.com/Peerframe/openbot/actions/runs/37475123514) tests the actual
PR merge `002d938113f9cd1f3b71a88a17fef809f0558d73`, whose parents are exact main `2bc69893`
and that branch head. The completed run succeeds with all17 jobs; security, both Linux product containers, installed
harness/HTTP contracts, macOS mixed Preview, Python/Worker and durable Temporal qualification
all pass. The hosted scanner reports23 exact historical
fixtures, production npm audit0 and all58 external Python product pins audited with zero known
advisories or skips. The local24-finding replay is preserved with its distinct fetched-history scope.

The unsigned, isolated macOS TS Preview and its lifecycle/performance receipts are available as
[CI candidate artifact11418388810](https://github.com/Peerframe/openbot/actions/runs/37475123514/artifacts/11418388810)
and [evidence artifact11419211146](https://github.com/Peerframe/openbot/actions/runs/37475123514/artifacts/11419211146).
These archives bind to the PR merge source above and remain automated Preview evidence; no
artifact was downloaded or installed. The previously qualified full canonical candidate remains
at `apps/desktop/out/ts-product/OpenBot-darwin-arm64/OpenBot.app`, with its separate fixed product
source `dfc8475f` and real Electron/safeStorage receipts. None of this supplies whole-interface
acceptance, restricted signing/access-group provisioning or registered Worker execution.

Hosted Python integration passes1,072 base cases/2 optional Temporal skips and1,589 Worker cases/
1 retained-history replay skip, followed by actual SQL/HTTP readback and session issuance/revocation.
Preparatory runs report451 passed/1 skipped and1,450 passed/596 skipped before the owned target;
those skipped cases are not counted as executed acceptance. The durable lane qualifies its separate
Python/Temporal recovery and adjacent release upgrade, not TS P4 ownership.

Final main verification finds accepted Claude interface [PR194](https://github.com/Peerframe/openbot/pull/194)
newly merged as `bc2b2e7e5960912d8a1033c74233e43f5c75a1e7` (51 UI/document paths). The completed
CI above remains qualified against exact base `2bc69893`; it does not attest this later UI integration.
The Owner's next request is the global credential-scan blockage from historical `a240b810` fixtures.
Codex published only the exact five entries/tests/bilingual triage as independent
[PR201](https://github.com/Peerframe/openbot/pull/201), source
`190a196db3b224bd2743c0ce01fb004d678589c4`, based on exact main
`bc2b2e7e5960912d8a1033c74233e43f5c75a1e7`, in worktree `credential-fixture-history` and branch
`codex/credential-fixture-history`. Its own focused26 tests, full repository check and independent
offline23-finding replay pass; original main rejects the same real output. Hosted run
[37481999400](https://github.com/Peerframe/openbot/actions/runs/37481999400) passes all17 jobs,
including security and protected `check`, at actual test merge
`0bdb8b3ede18aff3186419c02f130af2f7adcf88`; both parents match the exact main/source above.
On2026-10-07 (Asia/Singapore), the Owner explicitly approved this main merge. PR201 is merged
as `a6ec303054c69429aabb0a09c972d5dd87ace941` (GitHub receipt2026-10-06T17:00:20Z).
Its tree `ea1aaa293250f3a4e87752a6821c6af612331e3e` is identical to the source and actual test merge
qualified by all17 pre-merge jobs. The new main
[run37500153005](https://github.com/Peerframe/openbot/actions/runs/37500153005) independently passes
[security](https://github.com/Peerframe/openbot/actions/runs/37500153005/job/112394782241):23 exact
historical fixtures, zero production npm advisories, all58 external Python product pins audited
with no known advisories or skips. All17 main jobs have now completed successfully. Main contains
the five exact reviews. Existing failed runs retain their old source scope; a new PR run must use the repaired main instead of relabeling the previous result.
The independent patch does not implement Claude pages. The current checkpoint above now qualifies
the accepted PR194/main integration locally; current-candidate hosted CI and whole-interface
acceptance remain required before P3. PR200 has not been merged.

On2026-10-06 the Owner explicitly confirmed that Claude has no P2 whole-interface acceptance record.
That external gate remains pending; Python is the sole product writer and P3–P5 remain unopened.
The preceding continuation closed the hosted CI repairs and preserved the broader approved migration.
The installed ASAR still matches the P0 baseline. This round installs no system application,
modifies no existing profile and implements no Claude page or C29 feature. The preceding current-handoff
receipt edits were local documentation owned by Codex, separate from the then-published/tested code head;
they change no product, dependency, workflow or fixture source.

Current integration evidence (macOS arm64; CLI Node26.0.0, not the earlier packaged Node24):

- Generated TS contracts and actual Python/Web DTO parity passed 1,342 cases; contract client/target
  checks passed15. Default real registration inventory is121 operations, including C9 appearance.
- Direct Python and mixed TS HTTPS each passed270 integrated checks plus19 staged artifact checks
  (289 executions). Both exercised actual Web/Desktop request assembly and private Python sole-write
  composition. Signed publisher12 and synthetic models18 passed over TLS; model receipts show
  10 discoveries/4 explicit probes and zero unauthorized dispatch/retry/fallback.
- Migration checks passed13 with no skips and55 SQL files. Fresh S7 passed40, a separate actual
  published53→55 upgrade preserved seeded preferences/profile/greeting records and uniqueness,
  and delivery/cleanup checks passed20. Published first53 migration entries/SQL remain byte-identical.
- Base/Worker closures verify52/64 pins; the harness and wheel-build environments are project-local.
  The real Python base gate passed1,072 with2 skips. The first integrated Worker run genuinely failed
  two publication tests (1,587 passed/1 skipped): their synthetic handlers wrote the old Responses
  field after C7 selects Chat Completions. Fixing the shared fixture's text projection preserves both
  protocols and all real SQL/receipt/publication assertions; the focused runtime/model/result/profile
  rerun passed97. The complete rerun exits0: base1,072/2 skips (149.44s), Worker1,589/1 skip (631.04s),
  followed by real TS readback/session issuance/revocation checks. Base skips are the two optional
  Temporal modules exercised in Worker; the Worker skip requires retained synthetic deadline histories
  for actual SDK replay. This does not qualify that replay or P4.
- Production dependency audit initially failed one critical proxy-addr2.0.7 finding. The
  [reviewed transitive patch](retained-developer-tools.md#express-proxy-trust-transitive-patch-2026-10-06)
  updates only that lock entry to2.0.8. Installed trust positive/negative checks pass; the high-threshold
  production audit now exits0 (critical0/high0/moderate2). The affected TLS MCP suite passed30; the retained scaffold passed in the full repository gate. Earlier full-check attempts failed the stale S7 target pin, then a120-operation test
  assertion; both were repaired. `npm run check` now exits0: protocol461, TS entry33, Web676,
  Desktop575 passed/3 platform skips; typecheck33 tasks/11 cached, test27 tasks/12 cached and
  build19 tasks/12 cached. Cached results retain their scope and are not new executions.

Native re-staging genuinely failed the fixed Node archive download after120s; checksum/time bounds
were unchanged. A fresh curl download passed the same pinned SHA-256, then staging reused those
verified release bytes and verified59 locked product distributions. The first Electron packaging
writer was deliberately stopped (exit143) before reusing the retained, checksum-verified44.3.0
release cache; the rebuilt unsigned Preview packages current source. Its ASAR is
`a460a3676b64d03a6e7cd373d9fab5d94c3e650ed7b2cb77caddb51867388565`;
263 native source/migration files and five compiled Desktop launchers match. The bundle contains
1,115,397,045 regular-file bytes, including783,638,392 native bytes. Actual packaged API smoke
passed paired exits, parent EOF, SQL initialization, persisted restart, and unsafe-directory/missing
engine refusal with owned-process cleanup. That headless smoke uses synthetic encryption.
Separately, actual Electron on this exact ASAR completed native Owner login, creation/naming of a
Bot, graceful quit and restart with the saved Bot and realtime connection restored. Real native
`safeStorage` encrypted/decrypted the bootstrap; the encrypted bootstrap, private model key and
setup plan retained their hashes and0600 permissions. Both launches exited0, all13 captured owned
processes per launch stopped, and the disposable profile was removed. No model was configured or
called. The accessibility tree and persisted files provide functional evidence; screenshot capture
remained on an earlier screen, so pixel/visual acceptance remains unqualified.
[Current receipt](typescript-control-plane-p2-native.json) keeps older qualification separate.
No macOS Worker companion is included and no app is installed.

Fresh same-source Node24.21.0 native overhead also passed12 owned starts (3 alternating trials per
composition, fresh/restart), 2,400 timed reads plus240 warmups. Current medians: Python→TS fresh
5,264→5,672ms, restart4,104→4,624ms; native descendant RSS165,792→269,936KiB (about101.7MiB
extra); health0.566→0.994ms and channels10.234→11.292ms. Both compositions use this exact current
payload, preserve raw observations in [the overhead receipt](typescript-control-plane-p2-overhead.json),
and confirm all owned processes stopped/disposable profiles removed. Earlier source measurements
remain separate dated evidence. This measures API-only loopback behavior, not renderer/Keychain,
active Work/Temporal or public TLS capacity.

The accepted advisory integration has fresh evidence: 12 installed dependency regressions passed;
the production audit reports zero findings at every severity. `npm run check` exits0 with33
 typecheck tasks/28 cached,27 test tasks/23 cached and19 build tasks/16 cached; TS33, Web676,
Desktop575/3 platform skips and MCP scaffold2 actually executed. The full mixed HTTPS suite passed
270 integrated plus19 staged checks. An incremental refresh replaces only fast-uri3.1.7→3.1.8 on
the earlier cold-qualified payload, verifies91 applicable Node packages and192 unchanged compiled
workspace files, then packages and runs native lifecycle smoke. ASAR remains the exact `a460a367`
prefix above; the native fast-uri resource changes outside ASAR. This unsigned API-only Preview
contains1,115,399,312 regular-file bytes, of which783,640,659 are native. Its fresh12-start overhead
medians are Python→TS: fresh5,508→6,162ms, restart4,423→4,864ms, descendant RSS168,192→270,560KiB
(about100MiB extra), health0.618→1.072ms and channels11.014→11.845ms. Every owned process stopped
and disposable data was removed. The receipts preserve both original and post-patch observations;
the actual Electron/safeStorage journey is reused only for the unchanged ASAR components.

The installed baseline also contains the existing macOS Worker companion. The API-only Preview
intentionally excludes its production service identity, so it cannot establish full Desktop resource
equivalence. Full macOS arm64 TS packaging now has an explicit `--ts-product` mode using the
canonical app identity and requiring a validated companion before packaging. `--preview --ts-product`
retains its isolated identity and refuses that shared companion. This reuses the
[existing C19 packaging decision](macos-worker-host-package-and-registration.md) and reviewed
Node22.22.2/npm10.9.9 builder; no new service, dependency version, authority or registration path.
The focused package policy suite passes39, including actual refusal before packaging when the
companion is missing. The changed packaging source also passes `npm run check`:33 typecheck
tasks/31 cached,27 test tasks/25 cached,19 build tasks/17 cached; Desktop576/3 platform skips
and TS33 actually executed. The full resource checkpoint now passes from clean immutable source
`6e9d13edc77e0bb4b1aa797a9701cf16cd7a877c` (parents preserve both the migration checkpoint and
accepted main PR196). The existing builder used official Node22.22.2/npm10.9.9 and SDK27.0;
its app metadata and packaged runtime inventory match that commit. The unsigned full candidate is
`apps/desktop/out/ts-product/OpenBot-darwin-arm64/OpenBot.app`, ASAR
`ce65a5f77610129f5b903e150d09129efe807127dc9da655a9b5c55e3c301b7e`, with1,230,271,274
regular-file bytes, including114,866,973 companion bytes. All27,820 native regular files and32
symlinks match staging;37 compiled Desktop modules match ASAR. Packaged native smoke exits0 for
SQL initialization, restart persistence, paired exits, parent EOF and unsafe/missing-engine refusal,
with owned-process cleanup. It uses synthetic encryption and disposable data; no canonical GUI or
Worker registration is claimed. Existing Preview safeStorage evidence retains its separate identity
and dependency scope. Electron Packager skipped its optional `.icon` format; `.icns` remains.
No app was installed, Worker enabled, or user profile accessed; the installed ASAR still matches
its P0 hash. Candidate signing, restricted Keychain and whole-interface gates remain separate.


Before qualifying the canonical candidate's actual startup, source review found that the existing
macOS legacy-profile helper could override an explicit Electron `--user-data-dir`. That could
select an installed legacy profile instead of the disposable test profile. Keep the reviewed
Electron44.3.0 dependency and existing Desktop profile/key namespace policy, but let an explicit
profile bypass legacy discovery before filesystem probes. Default launches retain canonical-first,
legacy-compatible behavior. This is a repair to the existing native entry, not a new page or profile
framework. The helper's two new refusal cases cover a separate path and an explicitly selected
canonical path while an old Preview exists; existing default/corrupt-canonical cases remain.

Targeted primary evidence: [Electron app path API](https://www.electronjs.org/docs/latest/api/app#appgetpathname)
and the pinned MIT release commit `07e460719c75b2ec5ee4893f7d2192ef31c7b8c2` for44.3.0,
[main delegate](https://github.com/electron/electron/blob/07e460719c75b2ec5ee4893f7d2192ef31c7b8c2/shell/app/electron_main_delegate.cc)
and [path provider](https://github.com/electron/electron/blob/07e460719c75b2ec5ee4893f7d2192ef31c7b8c2/shell/common/electron_paths.cc).
The native delegate applies the nonempty CLI path before the JS entry; the path API and single-instance
lock use that selection. Respecting it in the existing helper costs one early guard; a test-only
bootstrap shim would bypass the real entry and leave this production bug. No upstream source copied,
dependency version, encryption format, data migration or permission is changed. Focused checks
pass7. The first full gate exits1 because the completed companion build's `.build/release` cache
link is rejected by the source symlink guard. After verifying the copied companion, remove only
this task's ignored Swift cache; the guard is unchanged. The full rerun exits0:33 typecheck tasks/
32 cached,27 test tasks/26 cached,19 build tasks/18 cached; Desktop578/3 platform skips actually
executed. The companion source/dependency closure remains byte-identical to6e9d13ed, so reuse that
verified immutable component. The rebuilt canonical candidate passes actual startup/restart qualification at exact product
source `dfc8475f1412a7742b40f99ce6b720f3a428afee`, ASAR
`f3f7edc56109338e53918a5ece92b60bd5bd4b2781232515d534df5851ff5e94`;
37 compiled Desktop modules match the package. The unchanged companion retains its6e9d13ed source.
Earlier resource/lifecycle receipts remain scoped to their exact immutable source.

Actual canonical Electron startup honored the explicit disposable profile and completed Owner
login with real native `safeStorage`. Creating and renaming one synthetic Bot, graceful quit and
restart restored its exact name and realtime connection. Workspace screenshots matched the
accessibility tree at these checkpoints; this is a narrow functional observation, not Claude's
whole-interface acceptance. The encrypted bootstrap (a JSON ciphertext string),32-byte model key
and setup plan retained their hashes and0600 permissions. Both launches exited0; all13 captured
owned processes per launch stopped, PostgreSQL PID files disappeared and the disposable profile
was removed. No model was configured/called, Worker selected/registered, or application installed.
The original app remained running and its ASAR still matches the P0 hash. Restricted Keychain
access-group provisioning, signing/notarization, hosted/deployment and active Work/Temporal gates
remain unqualified. The existing [native receipt](typescript-control-plane-p2-native.json) records
this current journey separately from the earlier Preview and headless qualification.

The integrated canonical Electron/safeStorage functional checkpoint is closed. The next bounded checkpoint is to reconcile the remaining P2 hosted CI and Claude whole-interface acceptance before switching a P3
writer. Python remains the sole product writer; P3–P5 are not active. Full migration remains
authorized; the remaining gates have not been relabeled as passing. The installed OpenBot ASAR still matches the P0 baseline
`e1effed06195fed8bd9269b2a7c8447562156ac8a216ae4b81ae35cc316432e0`; no Preview is installed in Applications.

### Preserved qualification of the earlier candidate

The Owner approved P0–P5; the full TS migration and Python/extra-runtime retirement goal remains
active. P1's local contract gate passed; P2 has locally verified HTTP/TLS forwarding and macOS arm64 native candidates, and P3–P5 have not
started. Checkout: `/Users/yxflc/Project/openbot`, branch
`codex/c22-c24-storage-follow-ups`, HEAD `010439bb9002fabb7e1facd8450ee85edbafa309`.
Pre-existing C28/model and workspace-primary changes, user data/config and installed Desktop are
preserved. The installed app remains the Python baseline; `apps/server-ts` exists but no Python
route has been removed. No commit/push/release or paid/live-provider call.

One implementer owns the uncommitted migration additions: shared HTTP/OpenAPI/native/Work schemas,
domain aliases, Web Work/native/storage/attachment/plugin/browser/portable projections, generation/parity scripts,
`packages/contract-tests` CLI/client/target and synthetic DOCX/Node/artifact/MCP fixtures,
`test-contracts-python.ts` with owned focused-suite/publisher selection, the actual Web/Desktop transport
fixture and narrow Desktop proxy repairs, existing CI selection/security additions
and bilingual records/maps.
Five Python contract/fixture scripts are included, including the synthetic provider entry.
P2 also owns `apps/server-ts`, the narrow Python private-peer adapter/resolver composition,
mixed fixture/CI commands, production-closure selection and third-party notices.
Native launcher/staging/probes, same-source overhead/CI and direct TLS entry additions remain in this migration scope.
Read actual dirty files before continuing.

Current division of work: Claude owns page implementation and overall interface acceptance. The
migration implementer owns backend/contracts and the native startup chain. Earlier P1 Web API/type
adapters remain necessary migration changes; do not expand them into page work or revert unrelated
Claude changes. Native startup/restart smoke is evidence for this migration scope, not page acceptance.
No application was installed into Applications. Locked project dependencies and one isolated TS
Preview bundle remain in repository output; the installed OpenBot and user profiles are preserved.

TS owns all120 actual default product HTTP definitions:8 Work,24 core control,32 resource,
17 lifecycle,10 Employee,4 automation,5 Node,12 plugin,4 browser and4 portability.
[Control OpenAPI](../../packages/protocol/generated/control-openapi.json) and Work compatibility
types generate without Python. Web plugin types now derive from strict HTTP schemas with an
explicit optional-result projection; retained Node plugin schemas remain compatibility contracts.
The [real inventory](typescript-control-plane-route-inventory.json) records default registrations,
reviewed Web/Desktop/Node/native Host consumer source digests and registrar/composition boundaries;
it does not establish complete conditional execution or migration acceptance. Product mode supplies
all registrars; optional publisher, Temporal/browser/command configurations affect service behavior
and existing wire surfaces, rather than missing default HTTP operations.

Reuse remains Zod4.6.2, openapi-typescript7.13.0 and generator TypeScript5.9.3. Local JSON Schema
references and marked recursive JSON-value mappings are tested; executable refinements remain
necessary. Reuse accepted C7/C19/C21/C22–24/C28, C3 audit, C49 approval, ADR-0047 identity, Employee
profile/memory/skills/knowledge, automation, Node identity, Run files, official MCP SDK1.29.0 and
C8 catalog decisions in [the reuse ledger](../OPEN_SOURCE_REUSE.md). P1 added no runtime dependency;
P2 uses reviewed Fastify/reply-from pins without copied upstream source.
Browser/portable changes reuse original Host/pause gates, review-bound export,
Agent Skills closure and reviewed activation/DSSE decisions in the same ledger.
Employee evolution/learning retains Hermes Agent attribution.

Preserve product `{error}`, standalone Work `{detail}`, raw integer-token refusal for Work/storage/
approval settings, decimal integral model/Employee revisions and automation intervals. Keep explicit
UUID/default/trim/code-point/UTF-8 adapters. Optional DTO nulls are generally omitted; required model
usage/progress, rejected knowledge `memoryId` and automation history nulls survive. SSE ready lacks
`occurredAt`. Password whitespace stays; lone surrogates are refused. Connection/PDF/memory/automation
bounds count UTF-16; imported Markdown counts UTF-8. Preserve raw URL control checks, numeric untrimmed
semver, product17 versus retained Node20 skill capabilities and memory surrogate503 classification.
Referenced identity, IANA zone, YAML/credential scans, merged-memory policy and dependency checks
remain service-owned. Audit retains allowed payloads, code-point truncation and nullable preference IDs.
Node bootstrap has no Owner/Origin requirement; issuance/revocation does. Preserve token/credential
rotation, socket disconnection,8192-byte admission and throttle Retry-After. Artifact reads retain
PNG/Markdown bytes, disposition and key/size/digest/no-follow guards.

Plugin UUIDs preserve case/non-versioned layouts; revision equality is case-sensitive. Python name
trim includes0085/C0 separators and preservesFEFF. Bounded direct strings count UTF-16 and refuse
lone surrogates; annotated collection values count code points, while unconstrained createdAt permits
lone-surrogate serialization. Endpoint syntax/DNS/HTTPS/exact-local policy, manifest digest, declared
grants and channel membership remain service-owned. No-op writes rotate revision; update always
disables and clears grants. Public records omit tokens. HTTP admission24576 bytes; inner content
input/normal result12KiB; declared app result160KiB. The owned MCP controller uses a distinct secret,
accepts only bounded declaration/content changes and never executes tools. Default PluginService
has no legacy Run guard: successful legacy decisions are unqualified; the HTTP route has only
Owner/Origin/shape/unknown-call refusal evidence. Native durable approvals remain a separate gate.

Browser HTTP preserves code-point bounds/raw AnyUrl spelling, strict actions and required public
control availability; Web retains an explicit optional-flag projection. Original Host credential/socket
binding, default-off human control and PNG byte/dimension checks remain service-owned. Real client
abort does not immediately release the wait through the current product entry: it retains the gate
until the original25s command deadline. The black-box case proves bounded release and no automatic
retry, not immediate disconnect cancellation. Synthetic peers are stopped and awaited before cleanup.

Portable contracts retain minute-precision UTC package timestamps versus browser second precision,
browser calendar year zero versus package years1–9999, strict appearance, bounded Markdown/license and
DSSE null-extension omission without changing encoded
payload bytes. Activate admits service-parsed inner JSON; checksum/trust/scanning/closure/review remain
service-owned. Strong review tags enforce412/428. Real unsigned v1/v2 download, quarantine, distinct
checksummed blocked packages and parallel activation prove one new identity/receipt with candidate,
model-disabled skills and no memory/Host authority. The separate publisher composition passed12
real HTTP checks using a retained-CLI ephemeral encrypted keyring: reviewed v1/v2 download bytes,
independent Ed25519 verification, trusted quarantine, raw signed-document/tamper/embedded-untrusted-key
refusal, non-authoritative hints and one signed concurrent-activation receipt with disabled candidates.
Only public key/fingerprint metadata reaches the runner. Private key/passphrase files are deleted
with their owned root, without loading `.env` or printing secrets. Import
requests are JSON-only; Web previously sent download MIME and got422, now uploads the same bytes as
application/json. Activation's registered200 differs from creation201/replay200; inventory preserves
registered evidence and the TS contract explicitly publishes both observed success statuses.

The preceding `contracts:test` passed1283 unchanged Web/Python/TS cases (one executes the171-case
frozen comparator); this evidence is reused. Current15 client/target tests pass, including scoped Work publication, public-only
publisher metadata and4 synthetic SSE UTF-8/frame/byte cases. Existing generation/OpenAPI evidence
is reused. The fresh all/inventory run on real owned `serve.py`/PostgreSQL/private
MCP CLI passed29 Work,34 resource,21 lifecycle,30 Employee,10 automation,18 Node/socket,17 integrated
Run/native artifact,30 plugin/MCP,14 browser/socket,13 portability/bytes and49 core/SSE checks:
265 integrated checks. Staged artifacts passed19, including both owned symlinks:267 distinct checks,
284 executions. The preceding separate signed publisher run passed12 and is reused; affected resource runs passed34, with
the actual Web/Desktop composition. Unknown/repeated options and partial inventory requests were
previously refused before fixture creation. A focused run cannot refresh the full route inventory;
the fresh all run updated120 actual registrations and34 reviewed consumer-source digests.

The separate model composition passed18 real Owner HTTP checks using the existing trusted transport
factory in real `serve.py`/PostgreSQL and retained SDKs. OpenAI Chat/Anthropic discovery/probe success,
256-item filtering/deduplication, unsaved verification, credential failure, redirects, invalid JSON,
oversized declared bodies and provider unavailability pass without exposing diagnostics/credentials.
Count-only receipts show exactly10 discoveries/4 no-tool probes, zero unauthorized dispatch/retry/fallback.
No public setting/header/route can select the fixture; no live provider, `.env` or paid call is used.
Its first failure was a test baseline mistake: the second unsaved verification compared against an
empty initial snapshot despite the first saved fixture connection. Per-request before/after comparison
corrected the assertion; owned saved records are deleted and the initial snapshot is restored.

Work's7 new checks qualify successful native approval/rejection, one concurrent decision/event,
expired/generation/digest guards, one pending lookup command and replay/CAS/cancellation over synthetic
SQL publication. Unknown outcome, null evidence/usage and revoked authority remain unchanged; no
executor is admitted or outcome resolved. The existing installed-TS Node/Worker differential pytest
passed1/1, and the retained comparators passed48 runtime wire,34 Owner commands and40 execution-value
cases plus20 failure codes. CI now requires unsigned all, signed publisher and models independently.
Adding variants exposed a substring-only CI check that could mistake a variant for all; exact complete
command-line validation fixes that gap, and focused target/workflow tests passed26/26.

Consumer tracing found two concrete Desktop failures: Owner upload lost its required filename header,
and six existing PUT families (settings, primary Bot, plugin grants) were refused by a reaction-only
allowlist. The proxy now preserves the two exact raw-upload endpoints and all seven declared PUT
operations without broadening other methods/paths or credential/Origin/body/redirect boundaries.
Focused Desktop checks passed45. The owned Node-Fetch fixture calls actual Web modules through the
actual proxy to real Python: five settings PUT operations plus Owner upload/list/exact download/delete
and deleted-content refusal pass; source digests inventory other consumer surfaces without pretending
they all ran. Native Work actions/artifacts remain display-only in bundled Web. Installed Electron,
Swift URLSession and Windows supervision/runtime qualifications remain separate evidence.

The [runner README](../../packages/contract-tests/README.md) defines reproducible inputs. Native Work
files use the existing private8MiB content-addressed root: exact PNG/Markdown/empty opaque bytes,
UTF-8 filenames, sandbox headers and strict snapshot digest/size/download links pass; digest/size
mismatch, missing files, oversized physical files and a valid-target symlink fail closed. Both owned
links are tested before removal because whole-root storage measurement correctly refuses symlinks.
Synthetic SQL publication is never Worker publication; no executor/Temporal/browser/live-provider
execution is established. MCP discovery/content/session cleanup is real with zero tools and no leaked bearer.

SSE sends content-free polling invalidations with no replay IDs. Real persisted messages invalidate
workspace/channel streams; multiple changes plus a slow reader coalesce and refresh authoritative
state. Channel tombstone and password revocation terminate channel streams and refuse reconnect;
workspace revocation also closes. Parser tests separately reject incomplete frames/UTF-8 and actual
UTF-8 bytes above4MiB. Low-volume slow-reader and synthetic framing evidence do not qualify saturation
pressure; that belongs to P2 mixed-entry forwarding. Per-request deadlines remain10s/35s for DOCX;
owned all-suite lifetime is180s, focused children120s, each stopped and reaped on failure.

Genuine corrected failures: text extraction is415 (successful released DOCX extraction is covered);
owned symlink correctly makes whole-root storage measurement503, so qualify it first and remove only
that link before integration; DOCX exceeded the old10s client limit, so only its two calls allow35s
against the product30s deadline. Other requests remain10s; the later all-suite budget includes browser/SSE deadlines. Plugin parity corrected
surrogate/direct-versus-collection/createdAt assumptions. Explicit scenario parsing fixed lost CLI
union narrowing. Browser/portable parity corrected strict appearance, DSSE null extensions and year-zero
calendar assumptions. The first total check caught the inventory's Work/HTTP union narrowing; the fix
passed scripts typecheck. The MIME422 and registered200/observed201 assumptions were corrected.
Control fixture Ruff check/format passed again; unchanged MCP/Work/export Ruff evidence is
reused from the preceding checkpoint.

The model/native-action checkpoint's `npm run check` exited0: docs12/12 over585 Markdown, research27/27 (PR-event skipped outside PR),
prerequisites10/10 (1 cached), typechecks32/32 (10 cached), tests26/26 (12 cached), builds18/18 (12 cached).
Protocol460, Web650, Desktop555 and contract-target/client15 tests passed;8 existing skips remain (release2, Desktop Windows3, Node
credential-store3; Node129 tests executed again). The first sandboxed total check stopped at5 existing
loopback tests with `listen EPERM`; the authorized retry completed them and the whole check.
Existing lint/chunk/Vite and MCP SDK
settings warnings are non-fatal. Final handoff prose receives focused docs/research/whitespace checks.
Owned HTTP/MCP children, Docker fixtures, private credentials and temporary directories were cleaned;
no owned product/fixture writer remained running at that checkpoint. The model/native-action total check completed.
The installed app is still the verified Python baseline.

P1 exit scope is all default public registrations/reviewed consumers, shared schema/Python/Web parity,
current Node/Worker wire and configured publisher/provider HTTP. This local gate is closed; hosted CI
is unexecuted. Existing optional Temporal/browser/command settings change execution of current surfaces,
not missing registrations. Keep successful legacy calls without a Run guard, trusted browser/tool
execution and engine publication in the affected P3/P4 qualification. Do not invent a fallback or
expand P1 into the engine rewrite. Saturation/forwarding/reverse switching is P2; native packaging is
P2/P5. The fixed-upstream TS entry and mixed contracts are now locally qualified below. Next:
qualify public/TLS peer composition and required hosted target checks
before any P3 ownership switch. Cold native packaging, independent Desktop startup/restart and
same-source API-only forwarding overhead are locally qualified below. Continue all approved
phases through retirement and native/hosted target qualification. The goal remains active; no user-input blocker.

P2 entry checkpoint: `apps/server-ts` is a real Fastify5.12.5/reply-from12.6.5 service with one private
numeric loopback HTTP destination, no body conversion, hidden retry, redirect following or alternate
authority. Raw Worker upgrades pipe bytes with bounded pre-handshake/stream buffering and shutdown;
the existing Python registry still authenticates every Host. An explicit ASGI single-hop adapter
reuses C19 network identity, supplies original login addresses and private enrollment source/digests,
and fixes advertised scheme/Host without enabling Uvicorn's general proxy interpretation.
Operator inputs are joint/fail-closed; the Python listener cannot be public in proxy mode.

Executed transport26/26 (real loopback synthetic HTTP/WS), Python43/43 focused route/peer tests with
no skips, workflow/selection37/37 and production-closure6/6. Raw invalid JSON/integer spelling,
duplicate query spelling, multiple cookies, raw/gzip bytes,307, original credential/Origin/If-Match/
filename, forged metadata, fixed target, zero503/socket-loss/mutation retries, pre-header abort,
128-request saturation/release, SSE backpressure/abort, WS binary/ping/close/immediate-head/non101
refusal and pending-handshake release pass. Synthetic backpressure blocks a256MiB source before
completion; it is not an installed/native/public throughput benchmark. WS refusal bodies alone are
bounded8KiB and reframed after Node removes chunk encoding; accepted WS streams remain opaque.

The mixed all suite passed265 integrated checks plus19 staged artifact checks (267 distinct/284
executions), actual Web→Desktop proxy→TS→Python settings/Owner attachment bytes, then signed
publisher12 and models18 with the same count-only10-discovery/4-probe receipt. A separate real
Node18 run checks SQL enrollment details have the expected forwarded source and direct-peer digest.
The final all run stops both owned services before mixed→direct→mixed on the same URL/SQL database;
the original session and Bot projection survive both switches, one writer at each step, before the
whole mixed suite and enrollment SQL evidence pass. No data migration or product fallback.

Genuine failures were resolved: aborting an already finished HTTP response affected a reused socket
and crashed the TS process during browser cleanup; abort only premature closure now. A paused raw
pre-handshake client missed FIN; use a bounded PassThrough and observe end. Copying chunked headers
onto decoded WS-refusal bytes produced an aborted client; bounded refusal reframing fixes it.
The first full check caught a fixture's incorrect database `.sql` field; use its actual `.client`.
The corrected `npm run check` exited0: docs12/12 over588 Markdown, research27/27 (PR-event skipped
outside PR), prerequisites10/10 (2 cached), typechecks33/33 (10 cached), tests27/27 (12 cached),
builds19/19 (13 cached). Transport24 executed in that run; unchanged cached suites keep their original
evidence, including the8 existing platform/release/credential skips. New source and fixture Ruff
check passed; legacy Python files are not reformatted wholesale. Hosted CI was not run.
Exact npm locks/notices and the selected production closure are in place; production audit0 at
high threshold still reports the2 moderate entries documented above. P2 is not closed by this local
candidate; native/public/TLS packaging/overhead qualifications remained at this entry checkpoint.
The native candidate is qualified below; installed Python is untouched.

Final refused-upgrade lifecycle adds2 positive/negative cases: wrong Host/forged peer closes before
upstream dispatch and leaves the entry available; refused sockets own error/end cleanup as well.
The final full check exited0 with transport26 newly executed, prerequisites10/10 (10 cached),
typechecks33/33 (32 cached), tests27/27 (26 cached), builds19/19 (18 cached); prior successful suites
were reused, not rerun. Four missing/invalid/repeated/TS-inventory CLI forms fail before any fixture
construction. The updated direct Python all suite passed the same265+19 checks and actual Web/Desktop
transport, with real SQL enrollment source/digest now verified as direct. Owned processes/containers,
temporary private credentials and fixture roots were removed; no owned fixture writer or long process remained at that checkpoint.

### P2 native candidate qualification

The separate `OpenBot TS Preview` macOS arm64 bundle selects TS/Python coexistence through a strict
resource marker. One existing PostgreSQL supervisor/migrator remains; Python is the only database
writer and listens privately, while TS owns the public port. TS receives only transport configuration.
Missing/malformed resources refuse before launching a writer; either child exit stops its partner,
and normal stop closes TS, Python, then PostgreSQL. The retained Node runtime is still required.

Cold staging, packaging and the packaged native smoke passed on the final compiled source. The smoke
checks real Owner login, database initialization/data retention, parent EOF, both child crash orders,
unsafe-directory refusal and configuration-without-engine refusal, including all owned process exits.
Its encryption callbacks are synthetic. Separately, actual Electron with a disposable profile verified
native startup, Owner login, a saved Bot, restart/realtime recovery and unchanged bootstrap/key files
through real `safeStorage` encryption/decryption. The final bundle recovered the same profile and quit
with exit0; its owned API/database processes were confirmed gone. No model call was made. Existing
installed OpenBot and its data/config were not changed or stopped.

Candidate: `apps/desktop/out/ts-product/OpenBot TS Preview-darwin-arm64/OpenBot TS Preview.app`.
Its final ASAR SHA-256 is `9464016f705a9bfe942586ce47474d0a0badcd206f9f80cdfbb946e749b3a60f`;
all five compiled launcher modules match the package byte-for-byte. Regular-file bytes (excluding
symlinks): app1,115,059,373; native783,415,863. The historical P0 installation is a different source/build,
so these numbers do not establish a migration size improvement. Python and extra Node are retained
until their approved retirement gates. [Sanitized native evidence](typescript-control-plane-p2-native.json)
distinguishes the earlier first-run/restart bundle from the final bundle recovery and synthetic smoke.

The final `npm run check` exited0 with a clean inherited environment and bounded workers:
`env -i PATH="$PATH" LANG=en_US.UTF-8 TURBO_ENV_MODE=loose VITEST_MAX_WORKERS=2 npm run check`.
Docs12/12 covered588 Markdown; research27/27 (PR-event skipped outside PR), prerequisites10/10
(0 cached), types33/33 (10 cached), tests27/27 (12 cached), builds19/19 (12 cached).
Desktop565 passed with3 existing platform skips, Web650 and TS transport26 executed successfully.
Earlier sandbox `listen EPERM` and three existing Desktop timeouts under worker pressure are preserved
as failed attempts; those unchanged Desktop tests passed6/6 separately and in the final full check.
No test timeout or gate was relaxed. Native policy/lifecycle tests and negative CI stage-removal checks
passed. The existing macOS preview CI lane now includes cold mixed staging, smoke, package and packaged
smoke; hosted execution is still unqualified. Final record-only changes receive docs/research/link checks.

This is an unsigned local API-only candidate. Public/TLS deployment, hosted target checks,
signing/notarization and Work/Temporal execution remain unqualified;
P2 and the full migration goal remain active. P3 writer switching still requires the remaining P2 gates.

### P2 same-source forwarding overhead before TLS

The pre-TLS [reproducible probe](../../apps/desktop/scripts/measure-ts-product.ts) ran on macOS27.0.1/26A434,
arm64, with retained Node24.21.0, current compiled Desktop launchers and the same newly staged native
payload for both compositions. Three alternating-order trials per composition each measured a fresh
profile and restart. The native/API scope and2s settling/three RSS samples at500ms match P0; this compares
current direct Python with current TS forwarding, not the older installed P0 source or renderer timing.
Each composition has600 timed health and600 authenticated channel reads, concurrency1, with10 warmups
per target/start. Responses were fully consumed and checked; requests and batches have deadlines.

| Metric | Direct Python | TS → Python | Difference |
| --- | ---: | ---: | ---: |
| Fresh profile ready median | 3,551ms | 3,596ms | +45ms |
| Restart ready median | 2,424ms | 2,563ms | +139ms |
| Native descendant RSS median | 156,504KiB | 256,128KiB | +99,624KiB (97.3MiB) |
| Health latency median / p95 | 0.571 / 0.930ms | 0.935 / 1.430ms | +0.364 / 0.500ms |
| Channel read latency median / p95 | 8.788 / 11.299ms | 9.990 / 12.602ms | +1.202 / 1.303ms |

[Raw observations and source hashes](typescript-control-plane-p2-overhead.json) preserve all12 starts,
including the16,453ms first direct fresh start; no outlier was discarded. Three startup trials do not
establish a reliable tail estimate. RSS pools18 samples per composition and excludes the observer's
`ps` child; unrelated installed OpenBot processes cannot enter its descendant tree. TS process RSS
median is99,544KiB. These are descriptive serial loopback/API-only costs, not a workload capacity or
public-network performance claim. Active Work/Temporal, renderer/Keychain and hosted platforms remain
separate. Coexistence still retains Python/extra Node; it does not deliver P5's size/runtime retirement.

The actual probe verified one or two owned product PIDs, stopped all product/PostgreSQL processes after
every start, confirmed health became unreachable and no descendants remained, then removed its private
roots. No existing profile, configured external transport or real model was used. An initial input
refusal caught whitespace drift in a packaged lifetime module before creating a database; a current
build/cold stage passed the strict hash check. The older packaged native receipt is retained with its
own ASAR identity, not relabeled as this staged-payload measurement. Three ownership tests passed;
the workflow's11 tests now also refuse removal of the new same-source overhead stage/receipt producer
in the existing macOS Preview lane. Hosted execution remains outstanding.

The final integration `npm run check` after the CI changes exited0 with the same clean environment and
two-worker command above: docs12/12 over588 Markdown; research27/27 (PR-event skipped outside PR),
prerequisites10/10 (0 cached), types33/33 (10 cached), tests27/27 (12 cached), builds19/19 (12 cached).
Desktop568 passed with3 existing platform skips; Web650 and TS transport26 executed again. The earlier
pre-CI integration run also passed; it is not relabeled as coverage of the later workflow changes.
The new probe's scripts typecheck and formatting passed. Final record-only edits receive focused
documentation/research/link checks; no unchanged full suite is repeated solely for this prose.

### TLS composition decision and local qualification

At the decision checkpoint, the entry accepted an HTTPS public-origin string without a TLS listener;
the string alone is not transport security. It also refuses all incoming forwarding headers, so an
extra TLS proxy would lose the original client identity without a new trust composition. Reuse direct
HTTPS in reviewed Fastify5.12.5/Node24.21.0. The fixed
[Fastify HTTPS API](https://github.com/fastify/fastify/blob/v5.12.5/docs/Reference/Server.md#https) and
[official HTTPS tests](https://github.com/fastify/fastify/blob/v5.12.5/test/https/https.test.js) establish
the released key/cert server path; its insecure fixture client is not an OpenBot acceptance pattern.
Keep explicit numeric IPv4 binding: [issue7043](https://github.com/fastify/fastify/issues/7043) concerns
the default secondary dual-stack listener; it is additional reason to retain this existing constraint,
not evidence that OpenBot TLS has passed.

Alternative [Caddy2.11.7/72dd0fb](https://github.com/caddyserver/caddy/releases/tag/v2.11.7),
[Apache2.0](https://github.com/caddyserver/caddy/blob/v2.11.7/LICENSE), remains maintained and supplies
TLS/reverse-proxy lifecycle with [header](https://github.com/caddyserver/caddy/blob/v2.11.7/modules/caddyhttp/reverseproxy/headers_test.go)
and [streaming tests](https://github.com/caddyserver/caddy/blob/v2.11.7/modules/caddyhttp/reverseproxy/streaming_test.go).
The release fixes stream/HTTP2 timeout regressions; existing
[proxy-header semantics](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) still need an
explicit trust contract. Adding a Go service plus a second peer boundary is unnecessary for this fixed
entry, so it is not selected or installed. Existing Node/Fastify licenses apply; no upstream source is copied.

The implemented entry validates operator-owned bounded key/cert files before listening, requires the
actual scheme/Host and certificate to match, and keeps TLS1.2 minimum, a5s handshake deadline and
192 TCP connections. Canonical POSIX paths, owned regular single-link files, mode0600 keys and no
group/world writes to the certificate chain are required; limits are16KiB/64KiB. Leaf CA status, SAN,
key match, validity and restricted extended key usage are checked. Reviewed Node24.21.0
[TLS](https://github.com/nodejs/node/blob/v24.21.0/doc/api/tls.md) and
[X509 APIs](https://github.com/nodejs/node/blob/v24.21.0/doc/api/crypto.md#class-x509certificate)
cover the APIs; [RFC5280 §4.2.1.12](https://www.rfc-editor.org/rfc/rfc5280#section-4.2.1.12) defines
extended-purpose restrictions. No generic trusted-proxy policy, ACME service or deployment is enabled.

The current-source transport suite passed33 tests, including real verified HTTPS/WSS, refusal of an
untrusted CA/plaintext/forged peer headers, raw bytes/secure cookie forwarding, stalled handshake
expiry and release of unfinished sockets/active tunnels on shutdown. Operator tests reject wrong SAN,
key mismatch, CA/client-only certificates, dates, unsafe modes, malformed/oversized files and links
before creating a listener. The disposable OpenSSL issuer follows the existing work-journey fixture;
no CA/key is shipped, and clients never disable verification or modify OS trust.

`contracts:http:tls` passed the real Python/disposable PostgreSQL all-suite (265 integrated plus19
staged-artifact checks), actual Web→Desktop→TS→Python settings and attachment transports, secure
`__Host-` cookie attributes, canonical HTTPS redirect, private direct refusal, same-URL/same-session
entry restart and Node identity source/digest. Signed publisher12 and synthetic SDK model18 passed
separately; provider receipts recorded10 discoveries/4 explicit probes and no unauthorized dispatch,
retry, fallback or live calls. The current HTTP all-suite also passed284 executions and its
mixed→direct→mixed session/SQL reverse switch; HTTPS restart is not relabeled as that removal test.
The existing Pydantic settings forward-reference warning remains nonfatal and unchanged.

Eight invalid TLS/driver argument combinations refused before product/database startup. Scripts
typecheck passed; all11 workflow positive/negative tests require the three HTTPS variants in the
existing contract lane. Focused Desktop launcher checks passed53 with2 existing platform skips,
including missing TLS resources refusing before Python starts. These are new executions, not the
earlier HTTP-only results. The file policy has POSIX evidence, not Windows ACL qualification. TLS
tests run only where POSIX UID support exists; a local negative test verifies missing UID support
refuses TLS before file access. The existing HTTP transport tests remain portable.

Qualification uses local CA/loopback and disposable data; public DNS/production PKI, hosted CI,
signing and active Work/Temporal are not established. The ADR's P2 gate remains mixed-entry/Desktop,
measured overhead, private upstream and reverse-switch evidence; do not replace it with an unrequested
production deployment. Required hosted CI still applies before integration/release claims.

The final TLS-capable native payload was rebuilt/staged/packaged with the existing locks; packaged
smoke passed parent EOF, both child crash orders, private configuration/directory refusals, Owner login,
SQL persistence/restart and complete product/PostgreSQL shutdown. Current ASAR is
`9db8fae930241a5d6a9dac7422469041d803453cc02ee6a87d61ac197a02fd76`. All five compiled Desktop
launchers and six TS transport modules match the staged/package resources. The native composition
uses loopback HTTP; HTTPS/WSS is qualified separately above. The earlier actual Electron/safeStorage
journey remains attached to its own ASAR, not relabeled as this package or overall UI acceptance.
[Native receipt](typescript-control-plane-p2-native.json) retains the original observation and a
separate `subsequentTlsQualification`. Current regular-file totals are1,115,071,028 bytes for the app,
783,426,291 for native resources; these do not establish P5 savings against an older source.

The final same-source native HTTP measurement used this exact transport/launcher payload, after the
full check finished. Three alternating-order trials per composition retained all12 fresh/restart
starts,2,400 timed serial reads and their warmups. No outlier was removed, including the17,567ms first
direct fresh start; three startup trials remain descriptive. The latest
[overhead receipt](typescript-control-plane-p2-overhead.json) keeps both earlier runs under
`previousRuns`, with their original source hashes/results rather than pooling them.

| Final metric | Direct Python | TS → Python | Difference |
| --- | ---: | ---: | ---: |
| Fresh profile ready median | 3,247ms | 3,604ms | +357ms |
| Restart ready median | 2,264ms | 2,596ms | +332ms |
| Native descendant RSS median | 158,464KiB | 259,248KiB | +100,784KiB (98.4MiB) |
| Health latency median / p95 | 0.568 / 0.916ms | 0.890 / 1.246ms | +0.322 / 0.330ms |
| Channel read latency median / p95 | 9.089 / 11.156ms | 9.913 / 11.600ms | +0.824 / 0.444ms |

The final `npm run check` after the POSIX scope/negative test passed: docs12/12 over588 Markdown,
research27/27 (PR-event skipped outside PR), prerequisites10/10 (10 cached), types33/33 (31 cached),
tests27/27 (25 cached), builds19/19 (17 cached). Desktop568 passed/3 existing platform skips and TS33
executed; Web650 was cached from the earlier successful full run at this TLS checkpoint. That earlier
full run executed Web650/TS32; it did not include the later missing-UID test. Repository Biome format
and whitespace checks passed; an earlier sandbox npx lookup failed DNS and is not counted as passing.

Both measurement receipts confirm owned processes stopped and disposable roots removed. Candidate
bundles remain in `apps/desktop/out`; no Applications install or persistent service was added. P2's
backend/native local candidate is ready; required hosted CI and Claude's overall interface acceptance
remain distinct outstanding evidence. The next checkpoint is to reconcile those existing gates and
prepare one P3 settings/read group with real forward/reverse SQL evidence; no P3 writer is active yet.
