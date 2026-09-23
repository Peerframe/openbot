# Research: compatible Bot/channel creation inputs (S2a write slice)

- Status: Accepted for S2a-1 continuation; implementation in the same package as the accepted read
  slice. Codex owns the routes, SQL and write transaction; this module only validates inputs.
- Date: 2026-09-23

## Targeted reuse decision (no new survey)

| Concern | Decision | Evidence |
| --- | --- | --- |
| Validation mechanism | Pydantic 2.13.5 models with `AfterValidator`/`field_validator`, already pinned and reviewed in this package | `apps/server-python/requirements.lock`; the accepted read-slice review |
| Enum ownership | **Reuse `models.Bot`/`models.BotAppearance` annotations by reference**; no second copy of the literal lists, and `models.py` is not modified | `openbot_server/models.py` (frozen public output contract) |
| Authoritative behaviour | The **retained OpenBot source and its tests**: `packages/protocol/src/index.ts` (542 `botAppearanceSchema`, 746 `createBotInputSchema`, 753 `createChannelInputSchema`) and the installed **Zod 4.6.2** implementation | `packages/protocol/dist/index.js` is loaded by the differential runner as the oracle |
| Trim semantics | ECMAScript `String.prototype.trim` (WhiteSpace + LineTerminator), **not** Python `str.strip()` | Zod `src/v4/core/api.ts:1188` `_overwrite((input) => input.trim())` |
| Identifier semantics | The UUID acceptance set of `z.string().uuid()`, i.e. Zod's RFC 9562/4122 pattern including its nil/max special cases; the text coincides with Zod's and is attributed rather than re-derived (see provenance) | Zod `src/v4/core/regexes.ts:33` |
| Length semantics | **Unicode code points**, which is what the installed Zod actually measures — the task card's "UTF-16 units" wording is not what 4.6.2 does (see below) | Zod `src/v4/core/checks.ts:569-574`, `src/v4/core/util.ts:992` |

The OpenBot schemas remain project-owned. The UUID pattern is adapted from Zod 4.6.2 (MIT),
commit e359f7378fe56d695134701cda1e9055a08892dc, src/v4/core/regexes.ts. Its full copyright/permission
notice is bundled in [the Python package](../../apps/server-python/THIRD_PARTY_NOTICES.md), so it
survives Python-only distribution. The whitespace set follows ECMAScript's documented productions.
Installed dependencies are unmodified; the existing read/auth dependency reviews still apply.

## Three behaviours the oracle settled that reading alone would get wrong

1. **Length is counted in code points, not UTF-16 units.** `$ZodCheckMaxLength` computes
   `units = input.length` and then, *only when that already exceeds the maximum*, replaces it with
   `util.codePointLength(input)` — with the comment "Strings are measured in Unicode code points,
   not UTF-16 units." So `"😀".repeat(33)` (66 UTF-16 units, 33 code points) **passes** `max(64)`,
   while 65 code points fails. Python's `len()` is already code-point based, so the compatible
   implementation counts code points and the fixture pins both boundaries.
2. **`z.object` strips unknown keys; null is not omission.** Both create schemas are plain
   `z.object` (only `botAppearanceSchema` is reused with `.strict()` at index.ts:845, for the
   employee template). Stripping applies at the top level and inside `appearance`. `appearance: null`
   and `computerProfile: null` are type errors — only an absent key takes the default.
3. **botIds: the 32-entry cap is checked before de-duplication**, de-duplication is
   case-sensitive and order-preserving (`[...new Set(ids)]`), so `A` and `A.toUpperCase()` are two
   entries. `nil` and `max` UUIDs are accepted; version 1–8 with variant 8/9/a/b is required, so a
   bare 8-4-4-4-12 hex string, braces, `urn:uuid:` and stray whitespace all fail.

Whitespace set used (the only characters JS trims): TAB, LF, VT, FF, CR, SP, NBSP, U+1680,
U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF. Python's `str.strip()` differs in both
directions: it also strips U+001C–U+001F and U+0085 (which JS keeps), and it does **not** strip
U+FEFF (which JS removes). Both are fixtures.

## Emitted JSON Schema metadata, not just behaviour

`AfterValidator` validates but contributes nothing to `model_json_schema()`, and
`identity_routes.input_schema` publishes these models as OpenAPI request bodies. Without extra work
the published request contract would describe unbounded strings, an uncapped array and no UUID
pattern. So the bounds are emitted from the same values the validators use
(`Field(..., json_schema_extra=...)`), and two tests hold every emitted keyword against the boundary
the validator actually enforces. Two limits are recorded in the module and in the schema
descriptions themselves:

- the bounds describe the *ECMAScript-trimmed* value, because JSON Schema cannot express "trim, then
  measure": a raw string padded with ECMAScript whitespace past `maxLength` is still accepted
  (`"  " + "a"*64 + "  "`), so a schema-driven client is stricter than the server;
- `pattern` is the only UUID keyword. `format: "uuid"` is deliberately not emitted: it denotes the
  whole UUID family, while the enforced set is versions 1–8, variants 8/9/a/b, plus nil/max.

Applying this change produced evidence for why metadata must not be mistaken for enforcement: while
moving the array cap into `maxItems`, the list `AfterValidator(_bot_ids)` was dropped, and the
differential runner immediately failed 5 of 81 cases (no cap, no de-duplication). Both now exist, and
one pytest case asserts `maxItems` against the real 32/33 boundary.

## Verification plan

A fixture of decision-relevant inputs only (no expected outputs) is executed twice: through the
installed compiled Zod schemas, and through this module inside `python -I` with an explicitly
inserted source path. Success/failure and the normalized public payload must agree; error codes are
reported but not compared. Local pytest cases assert explicit payloads for regression, including the
boundaries above, pin the reused enums against both the TS unions and `models.py`, and check the
emitted schema keywords against the enforced boundaries.

Out of scope: database existence, authorization, route status codes, the write transaction and any
claim that this module makes Python the writer.

Codex integration review: the optional appearance field uses the documented Pydantic 2.13.5
SkipJsonSchema annotation for its internal None sentinel, so OpenAPI no longer advertises a null
input that the runtime rejects. The exact omitted/null distinction is regression-tested. The
differential subprocess has a 30-second/2-MiB limit and decoded filesystem paths (including spaces),
with fixed paths, isolated Python and an explicit minimal environment.
