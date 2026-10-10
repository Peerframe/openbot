# Offline Employee publisher tooling

This retained developer package owns the offline `employee:publisher-key` CLI and its original
keyring/template dependency closure. It does not run the Server, access a database, or import
`apps/server` or the frozen test oracle. Source is initially unchanged OpenBot MIT code;
`SOURCE.json` records its origin and hashes, and `LICENSE` preserves the notice.

From the repository root after the normal locked install:

```sh
npm exec -- turbo run build --filter=@openbot/employee-publisher
npm run employee:publisher-key -- help
npm run test --workspace @openbot/employee-publisher
```

Use the [signing guide](../../docs/EMPLOYEE_SIGNING.md) for Owner-only key locations, trust,
rotation and Server configuration. The root launcher preserves the CLI's historical
`apps/server` relative-path base without requiring that directory to exist; prefer absolute
paths for new deployments. Never copy private keys or passphrases into an Employee package.

The original legacy TypeScript Server has retired; its frozen oracle remains test evidence. This package
retains the offline key lifecycle, template formats and validation. Obsolete Store contracts,
request schemas and task-routing functions from the original source closure have been removed.
`SOURCE.json` describes the initial extraction, including paths that have since retired; it is
historical provenance, not a current source manifest. Runtime authority belongs to the
TypeScript Server in `apps/server`.

The Server reuses the pure `agent-skills` and `sensitive-content` subpath exports, plus
`employee-package` for portability. The text parsers run without database, filesystem, keyring or
network authority, and none of these exports starts the offline CLI. The Server owns its
authenticated SQL transactions.
