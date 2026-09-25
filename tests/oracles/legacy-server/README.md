# Frozen TypeScript Server test oracle

This private fixture preserves the original implementation used by the Python migration's
compatibility tests. It is **not a supported Server, fallback runtime or second product
implementation**. Do not add features here. The intended final state is one Python business
Server plus this immutable test oracle, not two maintained backends.

`snapshot.json` records the exact original paths, working-tree baseline commit, SHA-256 and
size of 55 TypeScript files and four synthetic PDF/provenance assets. All copied bytes are
unchanged OpenBot MIT source; see LICENSE. The commit identifies the starting checkout:
`workingTreeSnapshot: true` means the hashes also capture accepted uncommitted changes.
Shared protocol/domain/database packages remain canonical and are not duplicated.

The closure includes type imports because the original source is compiled and typechecked
without rewriting it. The comparison App is constructed only by the disposable test
harness. There is no index/start/dev/serve/bin entry, package export or production dependency.
Only explicit `build:oracle` exists; all dependency pins are development-only and already
present in the repository lock. `filename-reserved-regex@4.0.1` has its own nested lock entry
because the old Server previously provided that resolution. No package release is upgraded.

Run from a fresh repository checkout after the normal locked dependency installation:

```sh
npm ci --ignore-scripts
npm run oracle:build
node apps/server-python/scripts/compare-task-contracts.mjs
node apps/server-python/scripts/compare-runtime-wire.mjs
node apps/server-python/scripts/compare-execution-values.mjs
```

The comparators also require the documented `apps/server-python/.venv`. `oracle:build`
compiles only this fixture and the retained database/domain/logging/protocol/Windows ACL
packages. It neither builds nor runs `@openbot/server`. `oracle:check` verifies exact source
hashes, rejects unexpected files/startup scripts and rejects references from product source,
package metadata, deployment and non-test scripts. It is a regression guard, not an OS
sandbox. The real PostgreSQL comparison remains `npm run test:control:python` after the
existing Python/Worker environment bootstrap; it owns and cleans its disposable Docker
fixture. `npm run db:verify` retains its existing synthetic database restriction.

The Python portability, plugin, knowledge and attachment tests now use this path. S7 uses
the same frozen artifact reader; its histories, migration executor and restoration checks
are unchanged.
Comparators that already use `packages/protocol` continue to do so. Existing historical
model-feature fixtures stay where they are. Do not refresh the oracle automatically from
apps/server; any change to compatibility evidence needs an explicit review and new hashes.

## Remaining retirement gates

This candidate removes **test dependency on the old business Server** for the consumers
listed in snapshot.json. It does not authorize a default switch or delete apps/server.
At extraction time, real remote product command and browser qualification were incomplete.
The mainline Owner authority, original Action, approvals, receipts, artifact review and
recovery boundaries still require their full product gates before switching defaults.

After acceptance, retire the remaining active legacy paths together:

- Root `dev`/`dev:server`, Desktop `prepare:native` and the legacy `main.ts` launch branch;
  the explicitly selected Python candidate already has an independent parser/DB package.
- `deploy/server/Dockerfile` and old Python-child container smoke (`smoke-python-runtime.mjs`),
  whose bootstrap/host/process closure is deliberately absent here. Replace that legacy
  bridge acceptance with product-entry acceptance before removing it; do not package this
  oracle into a runtime image just to keep the old smoke running.
- `test-runtime-headless.mjs` and legacy TS integration jobs in CI; keep their regressions
  until corresponding product acceptance is retained. They are not silently skipped here.
- The publisher-key CLI and the MCP example
  scaffolder's source path. Move remaining reusable tooling/assets to their proper retained
  package/test scope, not back through an oracle dependency in production tooling.
- Then remove apps/server startup/source/dist/workspace and its unique production lock
  closure, run npm's exact pinned clean install and all normal checks, product/container/
  Desktop packaging, S7 and active paired restoration qualification. Preserve required
  parser/SDK notices and test-only pins. Do not delete the canonical database migrations.

No blanket old-Server deletion or unsupported Linux/browser claim is part of this fixture.
