# Standalone MCP example

[English](README.md) · [简体中文](README.zh-CN.md)

The unchanged MIT notebook example and its static view live here independently of the old
TypeScript Server and test oracle. `SOURCE.json` records their original paths/hashes. The
example uses the existing pinned MCP SDK1.30.0 and Zod4.6.2; it runs only on loopback.

From the root after the normal locked install:

```sh
npm run start --workspace @openbot/mcp-example
npm run plugin:create -- /absolute/path/to/my-plugin
```

The scaffolder copies these two source files and the MIT license into a standalone project.
Use the [plugin guide](../../docs/PLUGINS.md) for installation, explicit loopback allowance,
per-Bot grants and approval; starting an MCP process grants no OpenBot authority.

`npm run test --workspace @openbot/mcp-example` creates an owned temporary standalone project
and exercises real SDK tools/resources/prompt over loopback, including origin/body/method
bounds. The historical catalog's alpha6 source path remains unchanged because its commit/tag
and digest identify that published version, not this checkout.
