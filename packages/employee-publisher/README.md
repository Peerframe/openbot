# Offline Employee publisher tooling

[English](README.md) · [简体中文](README.zh-CN.md)

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

The old Server temporarily retains unchanged keyring/template helpers for its existing runtime;
it no longer owns this CLI entry. Those helpers leave with the separately gated runtime
retirement, rather than becoming a second maintained implementation. This workspace is not
a production Server replacement and does not close Linux/browser acceptance.
