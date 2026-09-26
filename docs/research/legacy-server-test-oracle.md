# Test-only legacy Server oracle extraction

- Status: integrated and locally verified; researched before implementation, 2026-09-25.
- Boundary: retain fixed compatibility evidence without making the Python product or its
  distribution depend on the old TypeScript business Server. Default-runtime retirement
  still requires the outstanding browser and real remote product acceptance.
- Existing reviews: docs/OPEN_SOURCE_REUSE.md, python-parser-runtime-retirement.md,
  python-product-runtime.md and the exact historical model-feature fixture convention.
  The supplied TS_ORACLES.json is the starting inventory, not an automatically regenerated
  golden result. This extraction copies existing OpenBot MIT source verbatim.

## Primary evidence and selected existing tools

Read npm 10.9.9 workspace documentation at
https://docs.npmjs.com/cli/v10/using-npm/workspaces/ and TypeScript's NodeNext reference
https://www.typescriptlang.org/tsconfig/module.html. Inspected the installed TypeScript
7.0.2 manifest (Apache-2.0, gitHead 2bd066d87f5bafd315be9f40889d0a60b9e58e0b), the maintained
upstream https://github.com/microsoft/typescript-go, and the repository's existing compiler
configuration. Existing npm 10.9.9 / 745d8d90b5403110d26ba332ba83d8c5a51f0578 review,
lockfile/platform caveats, license and CI strategy are reused from the ledger. No new tool,
version, runtime, resolver, provider or parser is introduced. The current test bundlers
esbuild 0.28.2 and tsx 4.23.13 retain the identical previously installed/locked operations.

The first viable option is native npm private workspace metadata plus existing tsc
compilation. The fixed fixture has only devDependencies and a non-default build:oracle
script; exports is an empty map and no start/dev/build/serve/bin exists. A root test gate builds its
shared-package dependencies, verifies snapshot hashes and rejects production references.
The manifest does not synchronize the snapshot with the still-live legacy source.

Rejected: retaining imports through apps/server (prevents removal); hand-written or
precomputed Python golden answers (loses independent interoperability); moving all Server
code/tests now (unnecessary and breaks still-required defaults); bundling a new binary
oracle (harder provenance/source review); creating a second backend to maintain.

## Scope and verification

Copy only the 55-source transitive TS/type closure used by Python control comparisons,
portability/plugins/knowledge, database verification and S7 artifact readback, plus four attachment fixtures.
The three bootstrap/host/process files used only by the old container Python-child smoke
stay out: that smoke belongs to the not-yet-retired legacy container contract. Shared
protocol/domain/database packages remain canonical rather than snapshotted.

Pin every copied byte/hash, original path and consumer. Do not add a network listener
entry point or export a runtime API. Compile and execute the existing local comparison
programs from a temp mirror with apps/server absent; run focused existing Python parity
and attachment tests plus negative snapshot/boundary checks. Docker/PG tests are not
run in this assignment; the unchanged full comparative gate is handed to root.

Final deletion is a subsequent move/retirement, not ongoing dual development. Keep this
oracle immutable after adoption; product fixes belong in Python. A changed historical
compatibility baseline needs an explicit review and an explained manifest update.

The initial npm 10.9.8 offline metadata-only operation accepted the candidate lock
byte-equivalently at the JSON level. Integration then passed project-pinned npm 10.9.9
`npm ci --ignore-scripts --audit=false --fund=false` (591 packages, unchanged lock content),
`npm run oracle:build` and `npm run check`. The latter reused 31 test and 18 build task
results from cache; repository prerequisite checks executed. The complete owned PostgreSQL
`npm run test:control:python` gate then passed 826 base cases (two optional skips) and
1409 Worker cases. These are local integration results, not hosted CI or runtime cutover.

Node package export encapsulation is also checked against the official v22.22.2
[ESM resolver source](https://github.com/nodejs/node/blob/v22.22.2/lib/internal/modules/esm/resolve.js).
The official packages.md page could not be fetched; it is not counted as read. An empty exports map
refuses package-name imports; unlike null, it does not fall back to main/index lookup.
Direct fixture paths stay available only to the explicit test consumers and guard.
