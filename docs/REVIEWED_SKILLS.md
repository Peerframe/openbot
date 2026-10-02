# Reviewed skill instructions

[English](REVIEWED_SKILLS.md) · [简体中文](REVIEWED_SKILLS.zh-CN.md)

An Owner can now import a single `SKILL.md` under **Bot profile → Skills → Import**.
Paste its full contents or select a file up to 12 KiB, set a semantic version, and import it as a
candidate. Select that skill, inspect the entire file, give a reason, choose Verify, and explicitly
consent to sending that version to the configured model. The Server binds the review to its SHA-256.

Example file:

```markdown
---
name: evidence-report
description: Prepare a short report from the sources explicitly supplied in a task.
license: MIT
---
Read the supplied sources using the available tool. Separate sourced facts from inference.
Write a Markdown report if the report tool is available. State any missing evidence.
```

Then submit a native task to this Employee, for example: “Use evidence-report to prepare a short
report from https://example.com/.” An enabled supported model is still required. The Agent sees
bounded discovery metadata and can call `read_skill` to load the complete reviewed file before
following its workflow with existing tools. Each read records a content-free audit event containing
the skill ID, revision and digest.

## Review and execution boundaries

- Every version is immutable. To change instructions, import a new version and review it; suspend
  or revoke the old version when it should no longer be used.
- Candidate, suspended, revoked, digest-unreviewed and other-Employee assignments are excluded.
  Suspension or revocation invalidates already loaded references before the next step/tool and
  during the final publication transaction. Resuming creates a new assignment revision, so it
  cannot restore a previous task's authority. Already sent model input cannot be recalled.
- At most eight descriptors (4 KiB combined) are offered per task, with a truncation indicator.
  At most two complete files are read; the existing five-step/eight-tool task budget still applies.
- Only standalone instruction files without Worker capability or inter-skill dependency requirements
  can be used in native tasks. `allowed-tools` is descriptive and never grants a tool or network
  target. No scripts, archives, referenced files, filesystem paths or computer permissions are added.
- YAML frontmatter follows the pinned Agent Skills standard with bounded string fields. Ambiguous
  tags, anchors, aliases, directives, duplicate keys, unexpected fields and control characters are
  rejected. The entire Markdown body is retained and displayed as escaped text.
- Employee packages continue to export metadata only. Skill files and enablement do not travel with
  a template. Recipients must import/review the instructions separately.

The learning direction remains inspired by [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/63279301bcbdc185c1b07b98a9312eb0c862f26d).
This closes the reviewed instruction-loading gap; it does not implement arbitrary script execution,
full skill-directory portability or autonomous skill approval.

See [research and pinned dependencies](research/reviewed-skill-content.md).
