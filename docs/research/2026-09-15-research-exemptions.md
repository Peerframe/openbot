# Research: bounded documentation research exemptions

- Status: Accepted before implementation
- Date: 2026-09-15
- Owner: OpenBot contributors
- Related issue: fresh-contributor audit of the PR research check
- Acceptance journey: a spelling correction, faithful translation, or mechanical prose formatting
  change can use a short exemption explanation without inventing seven upstream research answers.
- Security boundary: a PR author cannot exempt source, workflow, dependency, executable-file, or
  policy changes merely by checking a box. The check reads committed Git changes. Existing review
  still determines whether prose changes behavior or claims; this is not a semantic proof system.

## Search evidence

- Search date: 2026-09-15
- Queries: `site.git-scm.com docs git-diff --raw -z --no-renames`, `site.github.com actions checkout
  pull request fetch-depth 0 HEAD base sha`, and `site.github.com actions labeler documentation
  changed-files pull-request`.
- Inspected the existing research-before-implementation gate and GitHub contribution entries in
  [the reuse ledger](../OPEN_SOURCE_REUSE.md), `AGENTS.md`, the PR template, validator and tests.
- Reviewed [Git's raw diff format](https://github.com/git/git/blob/e9019fcafe0040228b8631c30f97ae1adb61bcdc/Documentation/diff-format.adoc)
  and [raw-output tests](https://github.com/git/git/blob/e9019fcafe0040228b8631c30f97ae1adb61bcdc/t/t4002-diff-basic.sh).
- Reviewed the pinned checkout action input declaration and the labeler's source, test inventory,
  MIT license, latest release and open issues. Labeler issue
  [715](https://github.com/actions/labeler/issues/715) concerns configuration complexity; its other
  inspected open requests concern label colors or author/title matching, not research semantics.
- Primary documentation: [Git diff](https://git-scm.com/docs/git-diff) and
  [GitHub pull-request events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Git raw diff and object reads | Git 2.55.0 / `e9019fcafe0040228b8631c30f97ae1adb61bcdc` | GPL-2.0; documentation license | Reviewed raw-output tests; established CLI already required by checkout | NUL-delimited paths, file modes and immutable blob IDs give local change evidence without API credentials | Select existing CLI contract |
| Existing checkout action | 7.0.1 / `3d3c42e5aac5ba805825da76410c181273ba90b1` | MIT | Already pinned and reviewed in this repository | `fetch-depth: 0` makes the PR merge base available; credentials remain unpersisted | Reuse current action |
| [actions/labeler](https://github.com/actions/labeler/tree/bf12e9b00b37c5c0ca2b87b79b2daf7891dbda13) | 7.0.0 / `bf12e9b00b37c5c0ca2b87b79b2daf7891dbda13` | MIT | July 21 release; changed-files, labeler and fixture tests; active issues | Designed to assign GitHub labels, requires write permissions and does not compare document commands or claims | Do not add |

## Reuse decision

- Selected option: thin adapter over Git and the existing Node PR-body validator; no new dependency.
- The first viable existing interface provides actual change metadata. OpenBot adds only the
  policy-specific exemption fields, documentation allowlist, and conservative comparison of code,
  link destinations and markup. Unknown/missing Git evidence fails closed.
- The automatic path covers ordinary Markdown prose. Policy files, ADR/research records, code/configuration changes and
  changes to protected Markdown content use the existing research form. Pure source formatting is
  still exempt from *new* research under `AGENTS.md`: reference the existing module research and
  explain the unchanged behavior instead of manufacturing a new study.
- Git commands receive fixed arguments and validated SHA values, never shell-interpolated PR text.
  Raw diff and individual blob reads are bounded. No network request or write-capable token is added.
- Existing complete seven-field PR bodies remain valid. An exemption cannot supplement an incomplete
  research form; contributors choose one path. Human review of changed claims remains necessary.
- Replacement plan: replace this narrow comparison if the repository adopts a Markdown parser or
  a shared PR policy service; do not introduce one solely for this correction.

## Source incorporation

- Source copied or substantially adapted: no.
- No upstream code, template text, or Git implementation is distributed by this change. Existing
  dependency/action notices remain unchanged.

## Verification plan

- Accept a normal completed research form, spelling/translation around unchanged inline commands
  and links, and mechanical prose wrapping. Reject missing reasons, unknown categories, mixed forms,
  missing change evidence, source/configuration/policy changes, executable modes, changed commands,
  changed links and changed code blocks.
- Exercise the CLI against a disposable Git repository and a synthetic pull-request event, including
  a diverged base, misleading working-tree contents, missing objects and unusual filenames.
- Keep the existing `npm run research:check` inside `npm run check`; add full checkout history in the
  check job. The CI event schedule stays unchanged; PR-body edits alone do not promise a new run.
- Maintain English and Chinese contributor guidance. No product runtime or platform-support claim.

## Unresolved questions

- No general algorithm here can prove faithful translation or unchanged prose claims. The automatic
  check narrows obvious misuse; normal PR review retains that semantic responsibility.

## C1 decision reuse and developer entry — 2026-09-27

The existing Git/checkout pins and immutable-diff approach above remain valid. The changed assumption
is that every behavior fix needs the full seven-field presentation. Root policy now scopes fresh
research to changed dependencies/versions, public protocols, authority/security, persistent data or
material architecture. Ordinary repairs reuse their original decision and pins. A conservative short
form admits existing presentation/core helpers and tests; boundary owners, new source, imports,
dependencies, rules/prompts and unknown paths require the full form, which can still reuse evidence.
Negative CLI fixtures prove mixed dependency/permission changes cannot take the shortcut. This does
not prove semantic equivalence; ordinary review still follows consumers and checks changed assumptions.

Developer discovery uses existing plain files and the Agent Skills format already reviewed in the
ledger, without a new dependency or copied source. The scoped official lookup was `Codex AGENTS.md
.agents skills discovery`; read [Codex instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [skills discovery](https://learn.chatgpt.com/docs/build-skills) on 2026-09-27. The local verifier is
Codex CLI `0.158.0-alpha.2.1`. Root-to-CWD rules and CWD-to-root skills discovery justify plain local
AGENTS and `.agents/skills`; root links provide explicit reading when editing deeper paths. Existing
repository maps/design/contribution docs are retained rather than a new index service or knowledge
platform. Claude is not configured, so no duplicate compatibility instructions are introduced.

Validation: preserve the existing immutable-blob tests; add positive UI/core reuse, missing/mixed
fields, imports/new source, policy/prompt and boundary negatives, plus real Git/CLI exercises. Check
local references and skill metadata, actual native discovery and bounded new-context task reading.
No new dependency, upstream code or substantial upstream prose is incorporated; existing notices
remain. This is targeted wiring of accepted contracts, not another framework/language review.

中文：C1 保留原 Git/checkout 版本和不可变 diff 决定，只调整“每次行为修复填写全表”的假设。
普通修复复用原决定；新增依赖/协议/授权或安全/持久化/架构须针对性证据。保守短表仅覆盖已有
UI/核心纯辅助模块及测试，敏感和未知路径用可引用已有研究的完整表单。规则与 prompt 不属于纯文字。
开发入口复用既有地图/设计文档，按上方官方文档使用普通 AGENTS 和 `.agents/skills`，无新增依赖
或上游源码/正文复制；通过正反例、真实 Git/CLI、发现与新上下文阅读验收，不能将机械检查当语义证明。
