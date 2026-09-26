# Retained offline developer tools

Research recorded before implementation, 2026-09-25. Scope: the offline Employee publisher
CLI and standalone MCP example/scaffolder only. No default/HTTP authority/runtime/container
migration, new protocol, cryptography, dependency release or installation is introduced.

Reuse the accepted source/release/test/security/license reviews in
`docs/research/employee-publisher-key-lifecycle.md`,
`docs/research/posix-node-credential-permissions.md`,
`docs/research/third-party-mcp-plugins.md`, `docs/OPEN_SOURCE_REUSE.md` and the already reviewed
npm workspace/TypeScript relocation mechanism in `legacy-server-test-oracle.md`.

Pins remain Node22.23.2 Ed25519/PKCS#8/SPKI; write-file-atomic8.0.0 (ISC);
MCP SDK1.30.0 / 2d889f2b329e46680ec9bdd565de4616c497825a (MIT);
@sigstore/core4.0.1 (Apache-2.0); Zod4.6.2 (MIT); tsx4.23.13 (MIT).
No upstream source is copied: the ten moved/retained production files are existing OpenBot
MIT code. Each package keeps the original LICENSE and a source-path/SHA256 record.

The publisher's eight-file source/type closure is69kB. Reusing those original bytes avoids
extracting or reimplementing DSSE, canonical checksums, sensitive-field scanning and skill
validation just to relocate the CLI. It contains no DB client, HTTP listener, model loop or
Server startup. The old Server keeps its existing keyring/format helper until that runtime
is retired: changing it to a new package import would require changing the explicit Docker
COPY closure, outside this task. The old CLI entry is deleted. This is one retained offline
tool plus a temporary unchanged legacy runtime, not a new business backend to maintain.

MCP example/view move unchanged into a small existing-style private workspace. Scaffolder,
current documentation and test consumers use it; historical catalog ref/path/hash remain
unchanged because they identify the published alpha6 tree, not the current checkout. The
starter manifest's stale Zod4.5.4 pin is aligned with the already reviewed/locked4.6.2 used
by the original Server/sample, so local validation tests the actual declared versions.

Native npm workspace invocation changes cwd. A thin root Node launcher preserves the prior
apps/server relative-path base for four path flags and the two publisher env variables. It
only applies node:path.resolve, preserves missing flag values for the original CLI to reject; empty and whitespace paths
retain the original node:path.resolve semantics, and loads the same root .env via Node's existing --env-file-if-exists flag. It does
not read a real .env during validation or require the old directory to exist. No dotenv,
keyring, signing or argument-parser dependency is added.

Verification: original package/keyring regressions; actual synthetic CLI init/status/public
export/trust/rotate/revoke and Python reader/signature interoperability; wrong passphrase,
key permissions and overwrite refusal; actual generated MCP project over loopback with the
existing SDK, tools/resources/prompt/view and request bounds. All keys/configuration are
owned temporary fixtures and removed. No external service, paid model, Docker or VPS.

## Primary references checked for the relocation

- [npm 10.9.9 run-script](https://docs.npmjs.com/cli/v10/commands/npm-run-script/):
  a workspace script runs in its package directory. This explains the existing apps/server
  path base; the retained launcher resolves those paths without chdir into the old directory.
- [Node v22.23.2 node:path implementation contract](https://github.com/nodejs/node/blob/v22.23.2/doc/api/path.md):
  reuse path.resolve for relative, absolute, empty and whitespace path arguments, without
  a local path parser or filesystem probe. The launcher's four path flags and two environment
  variables are the complete existing publisher CLI path inputs.

These primary sources supplement the earlier reviewed releases/tests/issues/security/license
records above; there is no new cryptographic primitive, transport or upstream code copy.

## Retirement boundary

The retained packages are developer tools, not test oracles or an HTTP authority. Their source
provenance hashes describe the initial move; future changes use normal reviewed maintenance.
The source snapshots contain no imports from apps/server or tests/oracles. Existing legacy
MCP tests and S6 consume the retained example. The old signing/runtime helpers remain unchanged
only until the separately gated legacy runtime is retired; do not independently evolve both.
This relocation does not satisfy the remote Linux/browser or default runtime retirement gates.

## Integrated local verification

Pinned npm10.9.9 clean install passed with594 packages and unchanged lock content. The integrated
`npm run check` passed33 test tasks (30 cached) and20 build tasks (17 cached); the relocated tools
and changed legacy consumers executed. The twelve stale compiled files for the three removed
legacy entries were removed, then the affected Server build and seven shared dependencies rebuilt
successfully with cache bypass, preserving the current build cache without those old entries.

`apps/server-python/tests/test_employee_publisher_retained.py` retains the actual CLI-to-Python
signature/key-lifecycle check in the repository and the existing Worker gate. It passed independently
after integration. It uses the retained source through the existing tsx loader and the already built
shared contracts, with explicit temporary paths and no ambient credentials, database or network.

## Standalone MCP test entry — 2026-09-25

PR96 Windows CI exposed a child-process timeout in the real scaffold test. On a canonical
temporary path the `node -e` driver placed the imported example at `argv[1]`, activating the
example's direct-entry guard and its default4318 listener in addition to the owned port0 server.
An actual canonical-path reproduction completed all SDK assertions but reached the15-second
timeout. Its POSIX SIGTERM handler exited0, so the previous status-only check missed the leak.

Reuse Node's normal file-entry argv contract: write a separate temporary driver, pass the example
as `argv[2]`, and canonicalize the temporary root. Keep the same15/20-second bounds and all MCP
assertions. Require no spawn error, natural exit0, a marker after client/server closure and no
standalone-entry output. No SDK, sample source, lifecycle, dependency or privilege change is needed.
The two real-loopback cases passed locally after this repair; actual Windows CI remains required.
