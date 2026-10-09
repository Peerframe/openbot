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
rotation and Python configuration. The root launcher preserves the CLI's historical
`apps/server` relative-path base without requiring that directory to exist; prefer absolute
paths for new deployments. Never copy private keys or passphrases into an Employee package.

The legacy TypeScript Server has retired; its frozen oracle remains test evidence. This package
retains the offline key lifecycle, template formats and validation. Obsolete Store contracts,
request schemas and task-routing functions from the original source closure have been removed.
`SOURCE.json` describes the initial extraction, including paths that have since retired; it is
historical provenance, not a current source manifest. Runtime authority remains in Python.

The P3 TS candidate reuses the pure `agent-skills` and `sensitive-content` subpath exports. These parse bounded text without database, filesystem, keyring or network authority; they do not start the offline CLI. The selected TS service owns its authenticated SQL transactions. Default/reverse Python ownership is retained during migration.
