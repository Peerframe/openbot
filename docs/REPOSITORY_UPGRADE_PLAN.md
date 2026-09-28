# Repository upgrade — completion record

English canonical; 中文摘要见文末。This is the single engineering-upgrade task record.
[MIGRATION_HANDOFF](MIGRATION_HANDOFF.md) remains historical migration evidence.

## Current engineering-quality acceptance (2026-09-28)

- Status: the finite upgrade is merged and closed; no confirmed acceptance blocker remains.
  [PR #102](https://github.com/Peerframe/openbot/pull/102) was marked ready and merged on
  2026-09-28 at 10:56:11 UTC. Its authorized, unchanged HEAD was
  `98c8e00c6f6d290a6968cbe0fa52e80da145bc26`; main's merge commit is
  `413323f120100a3aaf45a1d09efaf497b886ab04`. Implementation and independent-review corrections
  remain pinned to `ef495bf1d118f8835442eb3c1d5f36241253fdcd`; `ee4251c` and `98c8e00` changed
  only this record. Both read-only reviewers and all local implementation/install writers finished.
- Checkout: `/Users/yxflc/.codex/worktrees/engineering-quality/openbot`, branch
  `codex/engineering-quality`; fixed base `4891b807b7b677820f82821f87b95c2bb80d74c3`.
  Its tree equals C3 `3b771c3`. The original user checkout and the separate contributor demos
  remain untouched. One implementation writer owns this checkout; review agents are read-only.
- Candidate CI: [run 36403361979](https://github.com/Peerframe/openbot/actions/runs/36403361979),
  attempt 1, passed all 17 jobs including `check` on the exact authorized HEAD. No job was rerun.
  PR #100/run `36291315723` is Base evidence only; older pending statements in the historical
  section describe their original checkpoint, not the current result.
- Merge rules were read before the action: strict required `check`, administrator enforcement,
  required conversation resolution, zero required approving reviews, no additional branch rules.
  Base/HEAD were unchanged, all checks succeeded, no review thread was unresolved, and GitHub
  reported `CLEAN`. The normal merge used `--match-head-commit` with the authorized full SHA;
  no administrator bypass, protection edit, force push or unsupported approval claim was used.
- Post-merge [main CI run 36412639452](https://github.com/Peerframe/openbot/actions/runs/36412639452)
  passed all 17 jobs including `check` on attempt 1, without reruns. The merge parents are the
  fixed Base and authorized HEAD; tree
  `b8cff931315f4e8d5f999ea87c8097f7e4ff32de` exactly matches the tested candidate. Existing
  implementation evidence therefore remains applicable. Main's existing push policy selects
  full hosted qualification; no unchanged full local suite was rerun.
- This closing record is a local documentation-only update after the merge, in this same worktree;
  it does not change the merged product candidate. Release, user-install replacement, production
  operations and paid model calls remain excluded.
- Finite acceptance: recursive source/public API boundaries; behavior-aware CI selection and
  cold commands; two actual tool consumers sharing typed result/lifecycle conventions; one
  existing Work HTTP request/response/error chain through Python and generated TS; core-only
  quality without Worker; proven CI duplication and affected installed-consumer checks. No
  new product capability, persistence model, authority, runtime loop or framework.
- First confirmed gaps: top-level-only boundary scanning and basename exceptions, blanket
  `.agents/`/prompt/Markdown CI exemptions, a cold contract command bypassing dependency builds,
  and core quality requiring the entire Worker environment. Regression fixtures precede repairs.
- Reuse: C2 harness/tooling/public API and OpenAPI decision in `packages/harness/RESEARCH.md`,
  C3 CI decision in `docs/research/windows-ci-merge-gate.md`, retained Temporal/security contracts.
  Existing three fresh-session contribution exercises stay evidence at their recorded revision;
  only changed routes need new reading/discovery acceptance.

| Area | Coverage status / current bounded action |
| --- | --- |
| Core | Confirmed scanning and local-quality gaps; preserve installed wheel and loop behavior |
| Control | Trace existing tool/result consumers and types before selecting repairs |
| Clients | Trace real Work API/Web/Desktop consumers, retain runtime validation |
| Execution adapters | Reuse process/Activity distinction; verify affected cancel/late-result cases |
| Contracts | Extend existing Work OpenAPI generation through request/response/error consumers |
| Build/CI | Confirmed classification gap; aggregate already rejects missing/cancelled/skipped jobs |
| Developer entry | Four existing skills reused; repair cold commands and verify fresh reading |

Selected paths: ordinary `PortToolset` → host result/model projection and Work
`ProductWorkReads` / `WorkWebAdapter` → `ToolResponseAdapter` / immutable `ToolResults`; Work
create/get/cancel DTOs → real FastAPI OpenAPI → generated TS → `work-api`/Web/Desktop.
The existing UI projection uses Work snapshot Action status and Artifact facts; tool JSON never
becomes an Artifact or independent business-success proof. No second projection registry is added.

Decisions reuse the exact C2/C3 pins and `docs/research/work-tool-results.md`: Python 3.12,
Pydantic AI 2.47.0, Temporal 1.33.0, FastAPI 0.141.1, Pydantic 2.13.5, openapi-typescript 7.13.0.
Rechecked [asyncio cancellation/timeouts](https://docs.python.org/3.12/library/asyncio-task.html),
[FastAPI additional responses](https://fastapi.tiangolo.com/advanced/additional-responses/) and
the [pinned generator source](https://github.com/openapi-ts/openapi-typescript/tree/5709d33a5977c4908b9e331f01cd0f9e181b1c37).
Use a single standard-library timeout over existing initialization instead of a new supervisor.
Retain manually bounded/authenticated request reads; register their existing DTOs in OpenAPI
instead of switching to eager FastAPI body parsing. Request definitions are lifted into standard
OpenAPI components, avoiding dangling nested `$defs` references. No source copied or new dependency.
Response nonnegative counters restate the SQL/UI invariants; no stored data migration or valid
product state changes. Additive response fields remain readable by older Web consumers.

Confirmed regression evidence: initial boundary fixtures failed 8 cases, CI fixtures failed 2,
initialization/cancellation failed 2, and a tool-result alias fixture bypassed its validated byte
bound. Fixes detach the exact model value and cancel pending initialization with the existing
deadline; resources still belong to their actual host/Activity. First boundary checkpoint
`bfddaba` passed 21 boundary, 24 CI and 4 entrypoint tests plus 535-document checks. Formatting-only
tool observation preparation is `b1b397d`, separate from its type changes. Lifecycle/result changes
are `6ac4eb2`; HTTP/developer integration is `e3ecf4e`; reviewed corrections are `ef495bf`.

Quality profiles share one existing tool environment; a 14-line optional SDK guard is the only
new runtime module, moved without changing behavior. Ordinary core type checks exclude only the
two Temporal adapters; mandatory full quality checks them against the real Worker SDK. Typed result
metadata/invoker contracts are shared by the actual read/web adapters; SQL/raw external data remain
dynamically validated at their existing trust boundaries.

CI duty change: remove the duplicate `test:browser:boundary` invocation from `python-runtime`.
Both copies used the same source and Linux/Node/Python boundary suite; `validate` already runs it
on full checks and whenever browser probe inputs change (selector positive/negative fixtures).
Browser-product/egress, real runtime and per-platform gates remain independent and retained.
No successful-test cache or new wheel cache is introduced. Installed artifact writers run serially.

### Fixed-diff review and corrections

Two read-only agents reviewed `4891b80..e3ecf4e`, then the fixed correction `ef495bf`.
Their confirmed P2 findings were reproduced and repaired:

- Removing the duplicate browser gate missed the probe's Linux helper dependencies. Changes in
  `experiments/linux-execution` now select the retained boundary gate in `validate`; runtime
  resources named `AGENTS.md` cannot impersonate contributor rules.
- `work-api`'s real scope dependency and its tests now select the cross-language gate. Eleven
  nonempty/boundary/invalid DTO cases and two actual HTTP cases expose case-insensitive duplicate
  UUIDs; Web now compares identity as Server already does, without rewriting input or authority.
  Error-body cancellation also had a reproduced regression and now propagates unchanged.
- The existing reads decorator erased return types to `Any`. `ParamSpec`/`TypeVar` retain its
  actual signature; a previously accepted invalid integer assignment now fails. Four permanent
  `assert_type` checks cover both real adapters in the existing full quality gate. The wrapper's
  runtime body and exception policy are unchanged, also checked by a focused invocation.

Both reviewers closed their findings at `ef495bf`, with no remaining confirmed blocker. One
independently executed CI selection 18/18 and 53 Python/Web fixture assertions plus three error
body cases; the other performed source review of the type remedy. Their fixture HTTP Writer is
synthetic, not database evidence. Reviewers did not write the checkout or shared caches.

### Current executed evidence

| Gate | Actual result and boundary |
| --- | --- |
| Repository at `ef495bf` | `npm run check` exit 0: 61.18s wall, 162.44s user, 26.32s system; all mandatory root checks ran |
| Turbo cache distinction | typecheck 31/31, 0 cached; test 26/26, 12 cached; build 19/19, 12 cached; Web 477, Desktop 402/3 skips and Node 94/3 skips actually ran |
| Core runtime | 449 passed, one optional Temporal module skipped; real SDK factory tests 30 passed separately |
| Boundaries/CI | recursive/public regressions 21 passed; final selector 18 passed; aggregate failure/cancel/missing/skip policy retained and passed inside full check |
| Quality | core-only 12 typed files; full real Worker 24 typed files and 25 formatted files passed; no new dependency, fake SDK or missing-import ignore |
| Cold core feedback | fresh Git snapshot, no Worker environment, fresh mypy cache; existing exact core/tool environments and download caches reused; `--core` 6.00s wall, 4.33s user, 0.37s system; full profile correctly refused absent Worker |
| Lifecycle current measurement | 30 tests passed in 1.29s; process wall 1.81s, maximum RSS 103,251,968 bytes. Three 20ms hung-init cases together took 0.07s and closed their pending loaders; late-after-deadline case 0.03s. Local scripted ports, not model/network latency |
| Work HTTP | 53 actual Python DTO/FastAPI → real Web consumer assertions; 31 focused Web scope/API tests; generated OpenAPI/TS freshness passed. Missing/null, ranges, Unicode, scope, error/status, cancellation and additive response compatibility covered |
| Cross-language retained interfaces | identity 129, task/routing/usage 60, runtime 48, commands 34 and execution 40 agreed |
| Actual PostgreSQL/control | 836 passed / 2 collection skips in 111.58s; the skipped optional Temporal modules ran in Worker |
| Actual Worker/SQL/tool consumers | 1,526 passed / 1 skipped in 555.34s, original 600s limit retained. Skip requires separately supplied retained collaboration histories. Executed before annotation-only wrapper correction; reviewers confirmed reuse, then full types and wrapper return/error/cancellation were retested |
| Outside-checkout wheel | freshly built wheel, clean temporary venv, `-I` site-packages, 19 exact distributions, `pip check`, no DB/Temporal/pytest; public tool example executes and closes |
| Actual Temporal | PostgreSQL + mTLS journey passed: approve while Worker absent, restart with planner disabled, same Action/single write, unknown retains reservation, explicit lookup recovery, cancellation prevents approved write, denial acknowledgement recovery and offline replay. Real HTTP/SQL/engine, scripted model/effects; 179.47s wall, probe-command maximum RSS 189,595,648 bytes (not container/service memory) |
| Actual arm64 container | image `openbot-quality-product:local`; fresh changed wheel/Web/product layers, unchanged Docker layers reused; 59 exact runtime distributions. Owner HTTP, built Web, docx/pdf/OCR, restart keys/files, 45 migrations, preflight refusal and SIGTERM/owned-resource cleanup passed; build 102.53s, smoke 33.34s |
| Actual macOS arm64 payload | staged and packaged-resource service smoke both passed: real Python API/PostgreSQL start/login/restart, parent EOF, unsafe directory/symlink/configuration refusal and cleanup. Stage 124.67s with the verified Node download reused; smoke 27.36s; unsigned packaging 211.91s; packaged smoke 23.33s. Synthetic encrypted profile; native Keychain and interactive Electron launch not qualified |
| Installed bytes/resources | all 13 core module hashes match source, wheel, core/Worker installs, staged and packaged Desktop, and container. Nine changed control/lock/notice files also match across product payloads; Desktop provenance matches the complete wheel SHA-256 and requirements hash; all 64 compiled Desktop/renderer files in actual `app.asar` match the verified build |
| Contributor entry | fresh-context reviewer found UI/core/wire ownership, generated files, `--core`, cold contract command and this record from the rules/map. Reuse C1's three actual isolated contributor exercises and native discovery; demo patches remain unmerged |

Raw local logs are `/private/tmp/openbot-quality-{check-final,core-final,review-types,core-isolated,
lifecycle-final,guard-smoke,scope-contract-green,error-abort-green,control,wheel,temporal,
container-build,container-smoke,desktop-stage-cached-download,desktop-stage-smoke,
desktop-package,desktop-package-smoke}.log`; failed
regressions are retained separately as `*-red.log`. No comparative speed or token saving is claimed:
there is no matched before/after workload baseline. CI saves one duplicate browser suite per
selected Python-runtime run; independent platform, engine and security gates remain.

Byte evidence is in `/private/tmp/openbot-quality-{installed-hashes,asar-hashes}.json`.
The local unsigned artifact is `apps/desktop/out/python-product/OpenBot Python Preview-darwin-arm64/OpenBot Python Preview.app`;
it does not replace the user's installation. All owned test containers/processes were removed.
The original checkout remains at `9cc73c9` with its original user-owned dirty files untouched.

### Revision-to-evidence mapping

| Revision/input | Review and validation correspondence |
| --- | --- |
| Base `4891b807b7b677820f82821f87b95c2bb80d74c3` | Same tree as PR #100 head `3b771c300533d3d4e780a9d867a702a5daed5b80`; hosted run `36291315723` succeeded on that PR head. It is Base evidence, not a run on this candidate |
| Core/lifecycle `6ac4eb2`, retained in `e3ecf4e779b469b8438a4381b821ac0e8f58506e` | Core source/tests and factory input bytes did not change between these commits. Core 449 and clean wheel evidence use these bytes, also matched to final installed modules. Original read-only review was fixed at `4891b80..e3ecf4e` |
| Pre-correction `e3ecf4e` control/Worker runtime | Actual SQL/control 836 and Worker 1,526 ran here. In `ef495bf`, the only changed Python runtime file was the reads decorator's typing, with unchanged executable body; full types and actual return/error/cancellation were then rechecked. New HTTP scope fixtures are separate Python DTO/FastAPI + Web evidence |
| Correction `ef495bf1d118f8835442eb3c1d5f36241253fdcd` | Both reviewers closed findings on this fixed diff. HTTP 53 and Web 31 ran on the input bytes committed here; full Ruff/mypy with permanent consumer assertions, final `npm run check`, real Temporal journey, container, staged/packaged Desktop and final byte comparisons cover this implementation |
| Local delivery `ee4251c2f68f75bb8758b26354918b91f396af59` | Only this record changed from `ef495bf`. Docs 4/535 files and research 22 checks actually ran; implementation checks are reused, not represented as new runs at `ee4251c` |
| Candidate `98c8e00c6f6d290a6968cbe0fa52e80da145bc26` | Only this record changed after `ee4251c`. Docs/research gates and PR-body validation ran; unchanged full local suites were reused. Hosted run `36403361979`, attempt 1, passed all 17 jobs including `check` on this candidate |
| Main merge `413323f120100a3aaf45a1d09efaf497b886ab04` | PR #102 merged the exact authorized HEAD with the unchanged Base. Its tree is identical to `98c8e00`; main push run `36412639452`, attempt 1, passed all 17 jobs including `check`. No source input changed, so local implementation/install evidence is reused |
| Local closing record after the merge | Only this file changes. `npm run docs:check` passed 4 entrypoint tests and checked 535 Markdown files; `npm run research:check` passed 22 tests, with its PR-event-only invocation explicitly skipped locally. Diff/link checks passed. No unchanged full local suite was rerun; this local record update does not alter merged main |

Final local Turbo results are **31/31 typecheck, 0 cached; 26/26 test tasks, 12 cached; 19/19
build tasks, 12 cached**. Cached logs are not fresh execution. Core feedback measurement reused
locked environments/downloads but started a fresh type cache in a snapshot without Worker.
Container unchanged layers and C1 contributor exercises are reuse; native discovery/three demo
edits retain their original revisions. No local success is promoted to hosted candidate evidence.

### Retained collaboration-history skip: still supported, not newly introduced

The exact skipped node is
`apps/server-python/tests/test_work_collaboration_deadline_replay.py::test_retained_history_replays_without_new_deadline_commands[NOTSET]`.
`OPENBOT_COLLABORATION_REPLAY_HISTORIES` was unset; the parameter list was empty and pytest used
the reason `Supply retained synthetic history files for real SDK Replay`. This is missing original
external history input, not a failing replay or an intentionally retired compatibility promise.

At Base the test and its skip condition are byte-identical. The retained C3 local Worker log
`/private/tmp/openbot-c3-control-final.log` records this exact node as skipped and 1,526 passed /
1 skipped. Base's [hosted Python job](https://github.com/Peerframe/openbot/actions/runs/36291315723/job/108541997596)
explicitly records the same skipped node and 1,526 passed / 1 skipped in 488.95s. The candidate's
hosted job records the same skip, as does the merged [main Python job](https://github.com/Peerframe/openbot/actions/runs/36412639452/job/108896279962)
(1,526 passed / 1 skipped in 483.23s). Main also ran core 449 passed / 1 skipped and PostgreSQL
control 836 passed / 2 skipped. These are actual main results, separate from reused local evidence.
The unchanged `scripts/test-python-control.mjs` constructs a scrubbed Worker environment without
the history variable, so that standard lane does not supply the opt-in histories. Do not infer
historical replay success from a green job badge. The local candidate log
`/private/tmp/openbot-quality-control.log` also records the same skip explicitly.

Compatibility remains supported: histories without `collaborationProtocol=1`, and old flagged
histories without `openbot-collaboration-deadline-v1`, retain their previous command sequence.
See [the original decision and four historical SDK replay results](research/python-work-collaboration-deadline.md).
Those four results were recorded on 2026-09-25; original histories were disposable external
evidence and were not committed. The test, `work_worker.py`, `work_collaboration_workflow.py` and
`work_corrected_workflow.py` are unchanged from Base in this upgrade. This is an inherited coverage
gap, not new evidence of a regression. Current mTLS approval/recovery histories passed replay,
but do not substitute for those older histories. No compatibility gate or assertion was removed.

When the original synthetic, pre-deadline histories are available, run this opt-in gate directly
(the ordinary scrubbed SQL runner does not forward the variable). Do not recreate them under the
new Workflow and describe them as old histories:

```sh
OPENBOT_COLLABORATION_REPLAY_HISTORIES='/absolute/root-history.json:/absolute/child-history.json' \
  apps/server-python/.worker-venv/bin/python -B -m pytest \
  apps/server-python/tests/test_work_collaboration_deadline_replay.py -v -rs
```

Paths use `os.pathsep` (`:` on this POSIX qualification host); the existing locked Worker closure
is required, while an engine connection and production credentials are not.

### Official Node archive: assisted installation versus automated download

The source is [Node.js v24.21.0, macOS arm64 official archive](https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz),
exactly `NODE_ARCHIVE.url` in `apps/desktop/scripts/python-runtime.mjs`. Size: 52,909,993 bytes;
SHA-256: `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`.

The first Desktop producer timed out downloading Node through Node fetch
at its unchanged 120s bound. Both clients returned HTTP 200 on diagnosis; curl transferred the
exact 52,909,993-byte official archive in 6.75s and matched pinned SHA-256
`bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`. A one-run temporary download
input reuses these bytes for that exact URL; the unmodified producer still checks its hash/size,
then installs the normal payload. This is reused download evidence, not a passing retest of the
original Node fetch transfer. No timeout, lock, production downloader or CI gate was changed.
Reproduce the **assisted archive path** from a macOS arm64 checkout with the documented built
Desktop/parser prerequisites. This temporary preload supplies only that exact public archive;
all other downloads use the original fetch, and the producer still enforces its own bounds and
SHA-256 before extraction. It does not change source, locks or the production downloader:

```sh
set -eu
quality_archive_dir=$(mktemp -d "${TMPDIR:-/tmp}/openbot-quality-archive.XXXXXX")
trap 'rm -rf "$quality_archive_dir"' EXIT HUP INT TERM
export OPENBOT_QUALITY_NODE_ARCHIVE="$quality_archive_dir/node-v24.21.0-darwin-arm64.tar.gz"
curl --fail --location --connect-timeout 10 --max-time 120 --max-filesize 67108864 \
  --output "$OPENBOT_QUALITY_NODE_ARCHIVE" \
  https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz
printf '%s  %s\n' 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057' \
  "$OPENBOT_QUALITY_NODE_ARCHIVE" | shasum -a 256 -c -
cat > "$quality_archive_dir/cached-node.mjs" <<'JS'
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (url === 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz') {
    const body = Readable.toWeb(createReadStream(process.env.OPENBOT_QUALITY_NODE_ARCHIVE, {
      signal: init?.signal,
    }));
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/gzip', 'content-length': '52909993' },
    });
  }
  return originalFetch(url, init);
};
JS
node --import "$quality_archive_dir/cached-node.mjs" \
  apps/desktop/scripts/prepare-native-server.mjs --python-product
node apps/desktop/scripts/smoke-python-product.mjs apps/desktop/out/python-product-runtime
node apps/desktop/scripts/package.mjs --preview --python-product
node apps/desktop/scripts/smoke-python-product.mjs \
  'apps/desktop/out/python-product/OpenBot Python Preview-darwin-arm64/OpenBot Python Preview.app/Contents/Resources/native-runtime'
```

The original ephemeral archive/preload were removed after successful byte verification. The
procedure above reconstructs them; no private path, credentials or hidden download override is
required. The normal automated route is `node apps/desktop/scripts/prepare-native-server.mjs
--python-product` **without** `--import`; the local unassisted transfer failed, so its success remains
unverified locally. The candidate's [macOS CI job](https://github.com/Peerframe/openbot/actions/runs/36403361979/job/108866298190)
ran that normal producer without a preload and passed staged and packaged service smoke. This is
actual hosted automatic-download evidence; it does not turn the earlier local failure or assisted
installation into a passing local automatic transfer. Native Keychain and interactive Electron
remain outside that synthetic-profile service smoke.

Artifact writers ran serially against the fixed implementation. The user authorized ready-for-review
and merge after the required gates; PR #102 is now merged at the SHA above. Signing/release,
updates to the user's installed app, production conversion and paid model calls remain excluded.

### Finite outcome and remaining limits

| Acceptance | Status / disposition |
| --- | --- |
| Public modules, dependency boundaries and reasonable extension | Verified: recursive checks, exact public exports, installed public example and actual consumers |
| Selected tools/control/API contract | Verified: shared typed immutable results, existing authority checks, real create/get/cancel chain and reviewed failures |
| Ordinary local core / required integration | Verified separately: no Worker required for core quality; actual Worker/SQL and mTLS journey retained |
| Contributor UI/core/wire entry and handoff | Verified current routing; prior accepted isolated modification exercises/native discovery reused explicitly |
| CI classification, aggregation and duplicate work | Verified: missing/failed/cancelled/unexpected skipped gates refuse success; one proven repeated boundary invocation removed without losing dependencies |
| Affected installed consumers and compatibility | Verified for clean wheel, Linux arm64 container and macOS arm64 staged/packaged service; current history recovery/replay and retained protocol differentials pass |
| Authority, budget, observations, publication and recovery | Verified within the existing synthetic-effects/real SQL+engine acceptance; no production or paid-model claim |
| Other platforms / special retained histories | Hosted selected Linux/macOS/Windows client and Linux amd64/arm64 container jobs passed. Windows Worker is build-only; Intel Mac, native Keychain and interactive Electron are unqualified. Original external collaboration histories remain missing, and the local unassisted Node download remains unverified. No compatibility commitment is retired |
| Hosted candidate CI / merge | Exact candidate and merged main each passed all 17 jobs on attempt 1, including `check`; no rerun or protection bypass. Base CI is never substituted for either result |
| Formal release / production qualification | Not applicable to this local unsigned candidate; signing, user-app update, native Keychain and production conversion remain separate authorized work |

The maintenance gain is concrete: contributors can find the owner/check command, check ordinary
core without assembling a Worker, receive type/contract errors before integration, and avoid one
duplicate browser suite. Added upkeep is narrow: keep the declared public-module list, explicit
cross-directory CI dependencies, four static consumer assertions and the selected HTTP runtime
validators/fixtures aligned as these actual interfaces change. One private Temporal helper was
moved, not duplicated; no new external dependency, service, framework or durable fact model exists.
No unrelated enhancement became an additional completion gate or product feature.

中文验收：本轮有限升级已完成、按授权合并并结案；两个只读审查的已确认问题均已复现、整改和复审关闭。
递归边界/CI 分类、核心初始化与取消、共享工具结果类型、Work 创建/读取/取消契约、开发入口和
检查去重均已落地。最终全仓检查通过；核心 449、工厂 30、跨语言契约 53、真实 PostgreSQL 836、
Worker 1,526 项通过，另有真实 mTLS 审批/取消/恢复/重放以及 wheel、arm64 容器和 macOS 暂存/
打包后服务验证。13 个核心模块、9 个控制/锁/notice 文件和 64 个 Desktop 编译文件完成字节比对。
缓存、历史复用与跳过已分别列明；Node fetch 曾超时，使用官方 curl 下载并验哈希后的同一归档完成
生产器验证，没有放宽限制。新增维护成本限于公开模块列表、真实 CI 跨目录依赖和局部类型/契约
样例，没有新服务或依赖。原用户目录和演示修改保持不动，预览未替换用户安装。原本地交付 HEAD
为 `ee4251c`，实现和复审固定于 `ef495bf`，后续仅补本文；完整 SHA 和逐项证据对应关系见上表。
旧协作历史测试 `test_retained_history_replays_without_new_deadline_commands[NOTSET]` 在 Base
已因缺少外部原始历史而跳过，仍是支持的兼容范围，本轮没有改对应 Workflow 命令分支；本轮
新历史重放不能冒充该旧历史验收。官方 Node 归档来源、完整哈希和临时复现命令已列出，人工
介入归档后安装通过与原自动下载超时明确区分；候选 macOS 托管 CI 正常自动下载和安装通过，
不能倒写为本地原路径通过。候选 `98c8e00` 的 17 项托管检查首轮全过；用户授权后，PR #102
转为正式评审并按现有规则合并为 main `413323f`，没有绕过保护。main 与候选源码树完全一致，
main 自动触发的 CI `36412639452` 也首轮 17/17 全过，含最终 `check`；未重复全量本地验证。
合并后仅在原工作树更新本记录，
不增加工程改造或 TS 迁移。签名发行、替换用户安装、生产操作和付费模型仍未执行。

## Historical C1–C3 record (preserved evidence)

## Baseline, ownership and current state

- Original checkout: `/Users/yxflc/Project/openbot`, branch `feat/cross-platform-employees`,
  HEAD `9cc73c9e78451e572f57d142d6b9caf62ccb78e2`. Its existing root AGENTS edit,
  untracked Chinese AGENTS, PNG and `output/` are user-owned and untouched.
- Implementation checkout: `/Users/yxflc/.codex/worktrees/repository-c1/openbot`,
  branch `codex/repository-c1`. Actual main was independently verified as
  `82f76059b97521065d88acb069b595af8a13ea54`; this is the base, not a reset to a report pin.
  Base [CI 36241261445](https://github.com/Peerframe/openbot/actions/runs/36241261445) passed;
  that is not candidate CI evidence.
- Local checkpoints: C1 `a770d870e81cb2295a1c4ed76da7796997c67716`; pure C2 move
  `17fb2f4`; C2 package/consumers `b6e623a`; C2 final evidence/quality `7399e11`.
  Resolve the current result with `git rev-parse HEAD` and `git status --short`.
- User requested continued completion after C1. C1/C2 and the C3 local implementation are accepted; **final hosted CI is pending**.
  One parent owns all integration files. The initial C3 implementation is `074f94d95e7066e7d04c657e3e65c8d1eb463df3`; handoff-only edits
  reuse that evidence. The subsequent PR #100 source-startup correction is recorded below. The final branch HEAD is the review candidate.
  On 2026-09-27 the user explicitly authorized branch push, then draft PR creation and CI.
  The branch was pushed and [draft PR #100](https://github.com/Peerframe/openbot/pull/100) is open
  against main. Final candidate hosted CI remains a completion gate. Merge, publication, paid
  model calls, production mutation and remote protection changes remain unauthorized.
- Separate acceptance checkout: `/Users/yxflc/.codex/worktrees/contributor-acceptance/openbot`,
  based on `7399e11`. All three contributor writers finished. All integration checks and artifact writers also finished.
  Demo patches remain isolated and must not be merged automatically. Its copy of this handoff
  records outgoing ownership so each new session can continue without oral project context.

## Reused baseline and preserved boundaries

Python was already the product control plane; TS Server retirement/oracle protection, Temporal,
TS/React, thin Electron and necessary Node parsers remain. The upgrade reuses those decisions,
not another engine/language survey. Identity, authorization, routing, approvals, root budget,
publication and audit stay in control. No second loop, ledger, recovery or product skill system.
The user's original working tree, SQL history and frozen oracle remain intact.

## C1 accepted evidence

Root plus six local rule scopes, four on-demand development skills, the existing maps,
contribution/research templates and design index now route to actual owners/consumers/checks.
Ordinary fixes cite valid decisions; new dependency versions, public contracts, authority and
persistence boundaries retain targeted evidence. The research shortcut rejects mixed dependencies,
authority owners, imports and unknown paths; it does not prove semantics by filename.

- Actual Codex native app-server `skills/list` discovered all four skills in root/Web/core/protocol.
  Four ephemeral `thread/start` calls returned correct root/local `instructionSources`; no
  `turn/start` or model call. A fresh-context reader independently located UI, core and wire tasks.
- Reader findings corrected the App-toolbar menu parent, stale TS defaults and contract references.
- `docs:check`: 4 tests, 535 Markdown files. `research:check`: 22 tests. Four skill metadata checks.
  Catalog 51 passed, 1 optional Temporal module skipped; real TS/Python wire comparison 48 cases;
  focused UI/API 9 passed. Final full `npm run check` passed.
- C1 first full Turbo groups: typecheck 31/31 (10 cached), test 31/31 (18 cached), build 19/19
  (14 cached). Final unchanged groups fully cached; root Node 196 passed/2 platform skips and
  browser Python 35 passed actually reran. Never count replayed cached logs as fresh tests.
- Logs: `/private/tmp/openbot-c1-{check,check-final,core-check}.log` and discovery JSON.
  These counts are historical C1 evidence, not claims about later changes.

## C2 accepted implementation and evidence

The one active core is `packages/harness/src/openbot_agent_runtime` (12 modules). The import name,
loop/guard behavior, wire and Temporal names are preserved. Hatchling builds an explicitly selected,
typed wheel; public exports, lazy optional Temporal import, AST boundaries, Ruff and mypy protect
it. Four legacy file-size exceptions have specific reasons; new modules use 400/300-line review
thresholds without refreshing away violations. All actual consumers install the wheel.

| Consumer | Current contract |
| --- | --- |
| Ordinary process | `runtime_executor.py` / `run-worker.py`; one invocation, bounded pipes and teardown |
| Product/Temporal | `work_runtime_ports.py`, `work_product_runtime.py`, `work_worker.py`; control factories and replay IDs unchanged |
| Dev | `serve.py`, `dispatch-work.py`, installed Worker environment; no core source PYTHONPATH |
| Container/Desktop | Same wheel in product environment; keep Node parsers/migrations, exclude build tools and source core |
| Extension | `examples/read_note.py`; canonical/model/UI projections, declined/error/unknown/cancel/revocation cleanup |
| HTTP contract | Actual FastAPI Work GET response → generated TS → real `work-api` consumer with runtime Zod |

| C2 executed gate | Result / limit |
| --- | --- |
| Outside-checkout wheel | isolated `-I`, site-packages, 19 exact runtime distributions; no DB/Temporal/pytest; synthetic tool succeeds |
| Core | 436 passed / 1 optional Temporal module skipped; extension 6 passed; later public-boundary 13 passed |
| Quality | Ruff/format and mypy passed, 18 typed core/example/real-consumer/contract-lock files |
| Work contract | 11 real Python HTTP/DTO → TS semantic cases; freshness and Web typecheck passed |
| PostgreSQL control | 836 passed / 2 skipped in 105.89s |
| Worker | 1526 passed / 1 skipped in 540.08s; original 300s/600s timeouts retained |
| Cross-language | identity 129, task/usage 60, runtime 48, commands 34, execution 40 agreed |
| Actual Temporal | owned PostgreSQL + mTLS engine, concurrent Runs, isolated cancel accounting/artifacts and real offline replay; scripted ports, no paid model |
| arm64 container | actual build/smoke: Owner login, built Web, docx/pdf/OCR, restart keys/files, 45 migrations, refusal/SIGTERM cleanup |
| macOS arm64 staged preview | actual install/start/login/restart, parent EOF, config/symlink refusal cleanup; synthetic encryption, no Keychain claim |
| Same implementation | all 12 module hashes matched source, core/Worker installs, final preview and container |
| Repository | full `npm run check` exit 0; final build 19/19, 18 cached; fixed-diff read-only reviewer found no confirmed regression |

Logs: `/private/tmp/openbot-c2-{control-final,check,desktop-final-smoke,container-final-smoke,contracts-final,wheel-final}.log`.
Source-hash evidence: `/private/tmp/openbot-c2-{source,container}-hashes.json`.
C2 closures: runtime 18 external + own distribution, dev 23 + own, Worker 63 + own, product 58 + own;
base control 52. C3's Soup Sieve security update requires fresh product evidence below.

## C3 check duties and artifact ownership

| Entry | Inputs/environment | Consumer and failure class | Output writer / order |
| --- | --- | --- | --- |
| `ci:scope` | actual immutable PR base/head/merge base, or separately local tracked/untracked; npm lock graph | Actions + affected validation; unknown/config/contract/lock scope expands, missing ancestry fails | scope job alone writes plan; same input recomputed by validate |
| `check:affected` / `check` | selected workspaces or complete repository; Node/npm identity, graph/config/env | contributor/validate; root gates, lint/type/test/build failures | existing Turbo dependencies; type/test/build phases sequential; full check unchanged |
| `ci:check` + `security:config-check` | fixed changes, real Git CLI, YAML, actual Turbo dry-run and empty Vitest | CI policy; canceled/missing/skipped required result, bad pins/permissions, swallowed failure | temporary fixtures only; no remote settings |
| `security` | full Git history, npm production lock, Python product lock; read-only advisory network | final check; credentials, advisory, missing/duplicate/skipped report coverage | isolated exact pip-audit tool env; private scan reports cleaned, no finding upload |
| `harness` | locked core/Worker/quality environments; real Python DTO/generator/Web consumer | installed API and contract lane; package/import/type/freshness/semantic failures | wheel producer precedes each install; same version; isolated tool venvs |
| `python-runtime` | installed wheel, base/Worker closures, owned PostgreSQL + synthetic HTTP/model fixtures | persisted product compatibility | fixture owner creates and cleans DB; no product data or paid model |
| `temporal-qualification`, browser lanes | actual engine, mTLS, PostgreSQL, Node/browser and owned egress fixtures | durability/replay/recovery/network boundaries | lane-owned containers/processes; traps/finally cleanup, no shared checkout |
| `portable`, Windows Worker | affected retained Node/Desktop/native host and platform runners | real bootstrap, transport, native packaging/platform contracts | Turbo builds once before native staging/package; companion before Mac package; build-only Windows host |
| product container | Docker runtime-product, exact Python/Node locks, two native architectures | actual install/start/restart/refusal/cleanup | multi-stage wheel and Web producers; isolated image + smoke-owned DB |
| Python Desktop preview | macOS arm64, built Desktop/parser dependencies, exact product closure | stage and packaged-resource startup/refusal/cleanup | stage → smoke → package → packaged smoke; never concurrent staging writers |
| synthetic migration | same-commit reusable workflow and disposable assets | migration/recovery compatibility | fixture owner; no production conversion |
| `check` / release workflow | explicit selected jobs + actual `needs`; separate tag-only release inputs | only required success satisfies aggregate; PR green is not release qualification | aggregate owns status; releases independently compare bytes, smoke, attest and retain artifacts |

C3 removed only the proven duplicate macOS release test invocation; its test remains in
`worker-host:macos:check`. Workflow checks now parse YAML and assert necessary properties, not peer
job order, step names or incidental counts. Immutable pins, minimal authority, required execution
order and artifact provenance remain checked. Scope fixtures passed before conditional lanes were
enabled. Security/validate always run; main pushes stay full. New/unknown contracts, locks, build
and CI inputs remain conservative. Scope follows transitive npm consumers and explicit Python/
Desktop edges; it is not another maintained dependency graph.

No-test workspaces no longer return Vitest success for empty collection; coverage is attributed to
actual consumers. Turbo hashes npm/Node/OS/architecture identity through npm's user agent, declared
runtime environment, source/lock graph and root script/generator inputs. `npm run`/`npm exec -- turbo`
are qualification entrypoints; raw Turbo without that identity is not. CI caches npm downloads,
not prior successful tests. Native qualification and uncached root/Python probes remain separate.

### C3 final local evidence (2026-09-27)

| Gate | Actual result / evidence boundary |
| --- | --- |
| Final `npm run check` at `074f94d` | exit 0; root Node 208 passed / 2 platform skips; browser Python 35 passed; 61.42s wall, 167.04s user + 26.77s system CPU |
| Turbo distinction | typecheck 31/31, 0 cached; test group 26/26, 12 cached; build 19/19, 12 cached. Web 473, Desktop 402/3 skips, Node Vitest 94/3 skips + Node test runner 53 actually executed; other package counts remain in the log |
| CI selection/cache/audit fixtures | 19 passed, including real Git committed/local separation, transitive/dynamic/contract/browser inputs, every required failure/cancel/missing/skip, environment hash changes and an actual empty Vitest failure |
| Workflow policy | `security:config-check`: 25 passed; YAML peer/step renaming accepted, essential sources/permissions/native/release/aggregate behavior enforced |
| Rules/docs/research | 4 discovery/routing tests, 535 Markdown files, 22 research tests; local non-PR invocation explicitly does not validate a remote PR body |
| Actual selection | final upgrade selects all 12 qualifications; clean candidate plus one owned README newline selected focused validation + security, passed in 8.73s (10.05s user, 2.81s system); exact README bytes restored |
| Cold contract | fresh Git snapshot had no node_modules/dist; direct old-style runner failed to resolve `@openbot/domain` and collected no tests. Canonical `contracts:test` built both dependencies without cache, then 11 cases passed; actual OpenAPI freshness also passed |
| Python quality | one existing Ruff/format + mypy entry now also checks the new audit verifier: 22 formatted files, 19 typed files; exact 7-tool environment and 12-module boundary passed |
| Dependency security | all 58 external production Python pins audited, no known advisory/skips; npm production audit found 0 vulnerabilities. Soup Sieve 2.9.2 metadata, all locks and complete MIT notices agree |
| Candidate Git history | pinned TruffleHog, network/verification disabled, full local candidate ancestor history: 13 exact pre-reviewed historical fixtures, no unreviewed finding. No new exception; private raw reports removed. This is not a scan of every remote ref |
| Fresh control/Worker | owned PostgreSQL base 836 passed / 2 skipped in 105.13s; Worker 1526 passed / 1 skipped in 524.53s. Same original 300s/600s limits; cross-language identity 129, task 60, wire 48, command 34 and execution 40 comparisons passed |
| HTML extraction | 54 public-source tests passed against Soup Sieve 2.9.2; C2 actual mTLS/replay evidence reused because engine/core behavior is unchanged |
| Final arm64 container | `openbot-c3-product:local`: Owner HTTP, built Web, docx/pdf/OCR, restart keys/files, 45 migrations, preflight refusal, SIGTERM/owned-resource cleanup all passed |
| Actual macOS arm64 app | staged runtime and packaged `apps/desktop/out/python-product/OpenBot Python Preview-darwin-arm64/OpenBot Python Preview.app` both passed Python API/PostgreSQL start/login/restart, parent EOF, unsafe/symlink/config refusal and cleanup; unsigned preview, synthetic encryption, no native Keychain claim |
| Same installed core | all 12 source-module hashes match Worker, staged Desktop, actual packaged Desktop and container; every consumer reports harness 0.1.0 and Soup Sieve 2.9.2 |

The new audit initially found six Soup Sieve 2.8.3 records representing four unique advisories.
Targeted review and the narrow 2.9.2 update fixed the real gate; no ignored advisory. A stale
pyproject pin was found during final closure checking; metadata/notices and a consistency check
were added before final packaging. The first concurrent Worker run hit its unchanged timeout;
sequential rerun passed. Existing bounded Desktop downloads timed out once, then the same producer
succeeded. A bare Git scan fixture was rejected; the same ordinary-clone layout as CI passed.
These failed attempts are not counted as passes or hidden by larger limits.

A read-only review of `7399e11..46ddb3e` found three real gaps: cold contract dependencies,
missing contract-consumer propagation, and skipped browser boundary regressions. Fixes at
`34a9394` / `5b09c33` were incrementally reviewed and tested, including the actual cold failure→pass
above. `6389bc4` added audit type coverage; `074f94d` preserves npm cache identity only in the
control fixture's build prerequisite (the passed Worker environment is unchanged). Full check then
passed at that final implementation revision. No later code change is hidden in handoff evidence.

### Three completed fresh-session contributions

All demos stay in the detached acceptance checkout; eleven dirty files are owned and described in
its copy of this same handoff. No demo was committed or merged into the integration branch.

| New context | Entry and useful feedback | Actual acceptance / cost |
| --- | --- | --- |
| UI | located App toolbar/member menu/design rules; first ArrowDown regression 4/7 failed | focused 31 passed; actual Python + owned PG page at 1440×900 and 390×844 checked keyboard/empty/disabled/failure/recovery/bounds. Full check passed; Web 478 and Desktop 402/3 skips fresh. 35 repo paths + one external skill, 15m45s |
| Python | read the prior handoff and local core contract; initial 3 failed/20 passed | installed-wheel example 23 passed, 1 optional Temporal module collection skip, 434 deselected; quality passed. Full check passed with Turbo groups cached; prior UI hashes unchanged. 24 repo paths, 7m07s |
| Python→TS | independently followed DTO→HTTP→generator→real Web consumer; initial 5 failed/17 passed | 32 actual FastAPI TestClient/DTO→Web cases, 22 Web API tests, generation/freshness/type/quality passed. Full check passed; Web 493 and Desktop 402/3 skips fresh, remaining cache labeled. Four prior demo hashes unchanged. 35 repo paths, 7m42s |

This proves two handoffs can continue from repository rules and one short current summary without
oral file answers. The contract task used a synthetic Writer behind the actual HTTP route, not a
production DB. UI synthetic services/browser/data were cleaned; all three writers stopped. Reading
counts include partial reads and exclude search-only hits. These are three usability samples, not
statistical performance gains. Real tokens, model price, active labor and hosted CI compute/wall time
are unavailable; local wall/CPU times above are not CI cost estimates or comparable-workload savings.

### PR #100 hosted qualification correction

The initial final-candidate run at `014a867` passed security, scope, repository validation, the
installed harness/contract lane, both product container architectures, Windows Worker build,
Linux/Windows clients, Python Desktop Preview, egress and synthetic migration. Its Linux runtime
lane then rejected the required harness wheel `dist/` as if it were a prebuilt JS workspace.
The cold source-startup preflight now identifies actual npm package manifests; required Python
wheel artifacts are permitted while prebuilt app/shared/provider JS and local `.env` remain
rejected. Focused regression fixtures cover both outcomes. The real `dev:smoke` and all downstream
runtime checks remain required in CI; no step or timeout is waived. The updated PR head must pass
hosted qualification before this upgrade is closed.

The correction passed all three new preflight regression tests and a fresh full `npm run check`
(`/private/tmp/openbot-pr100-startup-check.log`). A fresh temporary Git snapshot with `npm ci`,
new Worker/wheel installation and an owned PostgreSQL database passed actual shared builds,
Server/Web/proxy health and Owner authentication. Its macOS process-group cleanup probe then
returned `EPERM`, so this is not a full smoke pass. Independent process/port checks confirmed no
fixture service survived; the owned database and temporary snapshot were removed. Preserve that
failure in `/private/tmp/openbot-pr100-cold-startup.log`; the original Linux CI smoke remains the
required end-to-end gate rather than suppressing cleanup errors.

### Logs, limits and next authorized action

- `/private/tmp/openbot-c3-check-result.log`, `openbot-c3-control-final.log`,
  `openbot-c3-{ci-final,security-final,quality,python-audit-fixed,npm-audit,credential-summary}.log`.
- `/private/tmp/openbot-c3-cold-contract-{red,green,freshness}.log`,
  `openbot-c3-prose-affected.log`, `openbot-c3-upgrade-scope.json`.
- `/private/tmp/openbot-c3-{container-smoke-final,desktop-staged-smoke,desktop-packaged-smoke}.log`
  and matching build/package logs; four `openbot-c3-*-hashes.json` files retain installed proof.
- Contributor logs use `/private/tmp/openbot-contributor-{python,contract}-*`; actual UI viewport
  evidence is `/private/tmp/openbot-contributor-1440.png` and `openbot-contributor-390.png`.

No local C1→C2 entry blocker remains; local C2/C3 implementation and bounded acceptance are done.
**The overall upgrade is not closed:** the authorized branch push and draft PR are complete;
[PR #100](https://github.com/Peerframe/openbot/pull/100) is running hosted CI. Its actual remote
research body passed the existing local PR-event validator. Wait for the final candidate hosted
`check`, not base CI or local aggregate fixtures; any newer push supersedes an older run.
Native Windows/Linux lanes, both hosted container architectures and complete hosted recovery/
migration suites remain pending at this checkpoint. Read their final results from the PR. Native Keychain,
formal signing/notarization, user installation and release were outside this local candidate scope.

All owned test services, temporary DBs, cold/scan fixtures and writers finished or were cleaned.
Keep the unsigned generated preview for review, the isolated demos and the original user assets.
The integration working tree is committed and clean after this handoff-only checkpoint; always
recheck actual status before the next write. No paid model, production data or remote protection
was touched. Do not rerun unchanged full suites solely for this status record.

## 中文当前摘要

已完成 C1、C2 和 C3 的本地实施与验收；原 checkout 与用户修改保留。统一开发入口、正式 harness
wheel/真实消费者、扩展与契约链、按影响选择的 CI 和失败关闭汇总均已落实。三条新会话贡献及两次
真实交接通过，演示补丁留在独立 checkout。完整门禁、真实 PostgreSQL/Worker、最终容器与桌面包
均通过；新安全门发现的依赖漏洞已修复，未靠忽略或延长时限过关。缓存、跳过、合成与真实范围如上。
用户已明确授权推送、创建草稿 PR 和运行 CI；分支已推送，草稿 PR #100 已创建，真实 PR 正文通过
研究门禁校验。首轮云端检查发现冷启动校验误把必要的 Python wheel 当作预构建 JS；已修正识别范围并
保留拒绝预构建 JS/本地环境文件的回归测试。须以 PR 最新提交的最终 check 为准；本地证据不能替代
云端/全部平台结果。尚未授权或执行合并、发布、替换用户安装、付费模型调用或生产数据操作。
