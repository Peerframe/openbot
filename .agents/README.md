# OpenBot development entry

[简体中文](README.zh-CN.md)

This directory contains repository-development navigation and skills for contributors and coding
agents. It is separate from Employee skills and product runtime resources.

Start with [root rules](../AGENTS.md), choose one route in the
[repository map](../docs/REPOSITORY_MAP.md), then read that path's local rules, contract, consumer
and representative test. Setup and applicable validation are maintained in
[CONTRIBUTING](../CONTRIBUTING.md#ai-development-entry-and-validation).

## Choose the relevant workflow

| Task | Skill |
| --- | --- |
| Implement a scoped change | [openbot-change](skills/openbot-change/SKILL.md) |
| Select checks and diagnose a failure | [openbot-check](skills/openbot-check/SKILL.md) |
| Change or inspect Web/Desktop UI | [openbot-ui](skills/openbot-ui/SKILL.md) |
| Review a fixed diff and its evidence | [openbot-review](skills/openbot-review/SKILL.md) |

Read only the workflows relevant to the current task. The skills remain in `.agents/skills`;
this README is navigation, not another rules source or an automatic-loading guarantee. Actual
client discovery and the explicit-reading fallback are described in
[the contributor guide](../CONTRIBUTING.md#ai-development-entry-and-validation).

## Follow existing owners

- UI: [design entry](../docs/design/README.md), existing components and their consumers.
- Architecture and reuse: [repository strategy](../docs/REPOSITORY.md),
  [reuse evidence](../docs/OPEN_SOURCE_REUSE.md) and [research guide](../docs/research/README.md).
  Open only the affected decision; do not preload the research archive.
- Product and platform documentation: [documentation index](../docs/README.md).

The [completed upgrade record](../docs/REPOSITORY_UPGRADE_PLAN.md) and
[migration history](../docs/MIGRATION_HANDOFF.md) preserve dated decisions, checks and limitations.
They are not standing work queues. Resolve the current request, checkout and revision before
starting work; preserve existing local completion records and user changes.
