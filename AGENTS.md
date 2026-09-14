# OpenBot repository instructions

These instructions apply to human contributors and coding agents working anywhere in this
repository.

## Research before implementation

Before changing behavior, adding a dependency, designing a protocol, or expanding a non-trivial
feature:

1. search GitHub and the relevant official standards or primary documentation;
2. inspect maintained candidates, including source, releases, tests, open issues, platform fit,
   security boundary, and license;
3. pin the exact release or commit reviewed;
4. choose the first viable option in this order: open standard, released dependency, thin adapter,
   upstream contribution, narrow fork, then an OpenBot-specific local implementation;
5. record the evidence in the issue, an ADR, or a file created from
   `docs/research/TEMPLATE.md` before implementation starts;
6. state whether source was copied or substantially adapted and preserve every required notice.

If no suitable implementation exists, record the repositories and search terms checked and define
the exact gap before writing local code. A statement such as “custom is simpler” is not evidence.
Pure spelling, translation, and mechanical formatting changes are exempt when they do not change
behavior or claims.

When expanding existing code, first find its entry in `docs/OPEN_SOURCE_REUSE.md`. If it is missing
or marked partial, complete that review before expanding it.

## Product and security boundaries

- Keep the Server as the only source of truth for Employee identity, authorization, routing,
  approvals, and audit.
- Treat models, webpages, imported skills, messages, Worker Hosts, and Providers as untrusted.
- Capabilities do not grant authority. New side effects need explicit policy, fail-closed behavior,
  bounded inputs and outputs, and tests.
- Do not claim Windows, macOS, Linux, accessibility, or security support beyond the evidence in the
  conformance documents.
- The Employee evolution and learning direction is explicitly inspired by Hermes Agent. Preserve
  that attribution and do not imply that OpenBot originated the learning-graph concept.
- The office visualization is a deferred optional plugin. Do not expand it unless the requested
  milestone explicitly includes it.

## Contributor experience

OpenBot must be practical for independent developers to contribute to; delivery must not depend
on the project owner being the only person who understands, tests, or submits changes.
Follow the [contributor experience principles](CONTRIBUTING.md#contributor-experience): keep setup,
contracts, focused validation and PR handoff reproducible from a fresh checkout. Do not require
maintainer-private paths, credentials, paid model accounts, or verbal context for routine
contributions. Keep essential regressions in repository tests and wire environment-dependent
checks into CI with explicit disposable fixtures. Prefer a small documented extension point over
another overlapping local implementation or additional review ceremony.

## Engineering and repository hygiene

- English is canonical for source, comments, ADRs, and primary documentation. Maintain the Chinese
  translation for user-visible project documents changed in the same pull request.
- Use comments to explain authority, security, concurrency, lifecycle, and upstream constraints;
  do not narrate syntax.
- Keep commits focused and run `npm run check` before handoff.
- Never commit credentials, private transcripts, generated screenshots containing user data, or
  unrelated local assets.
