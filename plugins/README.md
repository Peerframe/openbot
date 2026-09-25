# OpenBot plugin directory

[English](README.md) · [简体中文](README.zh-CN.md)

Plugins expose capabilities through MCP Streamable HTTP. This directory contains reviewed catalog
metadata, not executable uploads. Installation and Bot grants always require a separate Owner review.

- [Protocol and limits](../docs/PLUGINS.md)
- [Runnable example](../packages/mcp-example/src/plugin-example.ts)
- [Catalog](catalog.json) and [schema](catalog.schema.json)
- [Submit an integration](https://github.com/Peerframe/openbot/issues/new?template=plugin-submission.yml)

A submission includes its source, exact revision, license, configuration, authentication, effects,
platform scope, success/failure tests and maintainer contact. A maintainer reviews these before a
catalog pull request is merged. Entries identify a reviewed release and source hash. They do not
verify a future mutable remote endpoint, convey authority or automatically run code.

The initial entry is the local development example. It is not a hosted service. Follow the protocol
manual to explicitly allow its loopback endpoint on the Server machine. New general capabilities
can be proposed for core inclusion through the normal research-first contribution process.
