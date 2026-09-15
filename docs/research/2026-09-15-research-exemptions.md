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
