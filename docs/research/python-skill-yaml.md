# Research: retained SKILL.md YAML syntax in the Python control plane

- Status: selected for candidate integration; product migration acceptance remains pending
- Date: 2026-09-24
- Acceptance journey: an Owner imports the same bounded Agent Skills document in either server.
- Boundary: untrusted metadata is parsed as data; aliases, tags, anchors, duplicates, directives,
  excessive depth and nodes are refused. No constructors, files, URLs or declared tools execute.

## Evidence and selection

The existing [review](reviewed-skill-content.md) pins Agent Skills
`69ef37e9424c0a7ea9dd2293b559e43ec8176379` and JS yaml 2.9.0. Its default core schema,
block/folded scalars, comments and flow maps must remain supported during language migration.
The initial inline-only Python draft is superseded before acceptance.

Queries on 2026-09-24: GitHub `yaml/pyyaml 6.0.3 release YAML 1.2 safe loader`, and the
[YAML 1.2.2 core schema](https://yaml.org/spec/1.2.2/#103-core-schema).
Reviewed [PyYAML 6.0.3](https://github.com/yaml/pyyaml/releases/tag/6.0.3), exact commit
`49790e73684bebad1df05ef8d828fa12f685bffb`: parser.py, events.py, the tests/lib and tests/data
layout, release history and [MIT license](https://github.com/yaml/pyyaml/blob/6.0.3/LICENSE).
The maintained release supports our Python 3.12 baseline without a Node backend.
[Issue 613](https://github.com/yaml/pyyaml/issues/613) documents its YAML 1.1 implicit boolean
behavior; therefore SafeLoader construction alone would incorrectly interpret `yes`/`on`.
The [official documentation](https://pyyaml.org/wiki/PyYAMLDocumentation) exposes a parsing event
API that avoids object construction and allows limits before any graph is created.

Select the released dependency plus a thin standard-schema adapter: PyYAML parses syntax; the
adapter consumes bounded events, accepts only string scalars/maps in the existing metadata
contract, and rejects unquoted core null/bool/number scalars. This is the first viable option;
retaining JS yaml through a subprocess would add a Node requirement to ordinary knowledge CRUD,
while a local line parser demonstrably loses existing formats. No upstream implementation source
is copied or substantially adapted. Dependency distributions retain their own MIT notices.

## Verification and replacement

Compare accepted and rejected documents against existing JS yaml 2.9.0, including folded/literal
strings, flow maps, comments, YAML 1.1 words, numbers, duplicate/typed keys, aliases/tags, node and
depth limits. Run knowledge mutation tests with the installed exact lock. Only the string/map
metadata contract is supported, as before; this is not a general YAML loader. Upgrade only with the
same differential cases. Missing/incompatible parser fails closed; there is no handwritten fallback.
