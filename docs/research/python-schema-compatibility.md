# Research: Python validation of Server tool schemas

- Status: Accepted; macOS and Linux/amd64 reference acceptance passed
- Date: 2026-09-23
- Owner: OpenBot maintainers
- Acceptance journey: The existing Owner report flow creates and downloads a Unicode-named report
  through the Python runtime without changing the Server filename policy.
- Security boundary: Server remains authoritative; Python validates declarative JSON Schema offline,
  with bounded patterns and no HTTP/file retrieval. Validation failures stop the run.

## Search evidence

The actual Server catalog (ten synthetic tool descriptors) fails Python jsonschema 4.26.0 schema
admission on write_report's Unicode property escapes. Official
[python-jsonschema documentation](https://github.com/python-jsonschema/jsonschema/blob/v4.26.0/docs/validate.rst)
acknowledges Python regex semantics. Checked the existing Server-host reuse ledger and the package's
RESEARCH.md; the latter selected this validator before real catalog integration.

Queries: GitHub `python jsonschema ECMA regex regress`; PyPI exact releases; official JSON Schema
[regular expressions](https://json-schema.org/understanding-json-schema/reference/regular_expressions).
Reviewed released bindings, tests, changelogs, license and open issues below. No relevant open issue
was returned by the first 100 open issues query for jsonschema-rs (not a proof of absence).

## Candidate comparison

| Candidate | Exact release / commit | License | Fit and decision |
| --- | --- | --- | --- |
| python-jsonschema | 4.26.0, package's existing review | MIT | Retained historical evidence; Python `re` refuses the actual Unicode schema |
| regress | 2026.9.1 / 97466b8700233b5026d993dbeb06bc79d0834c93 | MIT | Unicode ECMA engine works, but a local extension must also replace regex use in additional/unevaluated property handling |
| check-jsonschema | 0.38.0 / 12e63946db2c5cfcc9030fac21c3883ba88c6ed8 | Apache-2.0 | Reviewed regex_variants.py; full CLI/dependency surface is unnecessary and partial keyword adaptation is insufficient evidence |
| jsonschema-rs | 0.57.1 / 5f2f3f341f20a9460caef88f017d10ce2dc91227 | MIT | Select released complete validator with offline mode, ECMA translation, pattern limits and Python wheels |

## Reuse decision

Use jsonschema-rs Draft202012Validator with offline=True and validate_formats=False. The format
annotation behavior remains unchanged. Set FancyRegexOptions to 10,000 backtracking steps,
10 MiB compiled pattern size and 2 MiB DFA cache. The initially probed 1 MB compiled-size limit
rejected the legitimate Unicode character classes; 10 MiB admits them. Do not strip patterns,
rewrite schemas, restrict filenames to ASCII, enable remote references or change Server Zod rules.

Read pinned crates/jsonschema-py/{README.md,CHANGELOG.md,python/jsonschema_rs/__init__.pyi,
src/lib.rs,src/retriever.rs,tests-py/test_retriever.py,tests-py/test_patterns.py} and root LICENSE.
[Source](https://github.com/Stranger6667/jsonschema/tree/5f2f3f341f20a9460caef88f017d10ce2dc91227).
Bindings apply offline() after registry options; caller code will supply no registry or retriever.
Reference resolution now fails during catalog compilation, before any model or tool request.
The published macOS universal and Linux x86_64/aarch64 wheels exist, but platform claims require
actual checks. The upstream pattern test includes an xfail for an obsolete backtracking example;
do not count it as proof that every regex denial-of-service case is covered. Server process
deadline remains an independent cap; a Python process is not an OS sandbox.

Replace jsonschema/referencing and their now-unused closure with the reviewed released dependency;
keep the SDK and all other existing pins. Refresh the exact lock and verify in a clean environment.
On missing/incompatible dependency, startup preflight fails without installing or falling back.
Future upgrades require the same catalog/reference/Unicode regressions and cross-language gate.

## Source incorporation

No source copied or substantially adapted. Use public package APIs. The MIT distribution retains
Dmitry Dygalo's copyright and license; no upstream source vendored.

## Verification plan

The isolated macOS probe compiled all ten real synthetic declarations and accepted Chinese,
accented and ASCII report names while refusing traversal, wrong extension and emoji names.
It refused HTTP/file $ref and $dynamicRef, invalid schema types and malformed patterns; local
references and Unicode patternProperties combined with additionalProperties/unevaluatedProperties
worked. These are probe results, not completed product integration.

Add durable package regressions for those behaviors, retain authority/limits/no-retry tests,
update reference tests for earlier catalog refusal, and verify fresh locked dependency closure.
Run real Python/Server/PostgreSQL acceptance, the Linux fixture, and npm run check. Update both
package READMEs and current reuse ledger. Live provider quality, crash recovery, OS isolation and
production Linux deployment are outside the support evidence of this validator change.

## Unresolved questions

Full package and Server integration results remain pending implementation. Unusual plugin schemas
may still be unsupported and must fail closed; no claim of universal MCP schema compatibility.


## macOS integration verification

After the bounded adapter change, 367 Python package tests passed (71.24s). The real Python process
then passed all 222 Server/PostgreSQL cases across nine files (49.09s), including the report with a
Chinese name, plugin approvals, cancellation, revocation, shared budgets and joined delegation.
`npm run check` passed after the product changes. CI wiring is additionally validated by the
existing twelve workflow tests; native hosted CI remains unrun. Linux results are pending below.


## Final reference acceptance (2026-09-23)

The Linux/amd64 fixture exited zero: 369 Python tests (137.20s) and 222 Server/PostgreSQL tests
across nine files (73.26s). This includes the two late WorkBuddy CLI regressions for post-revocation
silence and whitespace refusal, which Codex reviewed and also reran in the 31-case macOS lifecycle
file. The TypeScript lane passed 222 tests with the same Unicode report. Full npm run check passed,
as did standalone built-Server health, Owner login and workspace API with Python selected.
The required CI lane is wired but has not executed remotely. All owned fixture containers and
unique acceptance tags were cleaned. No live provider request, publication or deployment occurred.
