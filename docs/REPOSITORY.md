# Repository strategy

## Decision

The foundation uses **one monorepo**. No upstream fork is required to build or test the initial
Server–Node protocol and product shell.

| Repository | Required now | Responsibility |
| --- | --- | --- |
| `openbot` | Yes | Web, Server, Node, shared contracts, providers, deployment and docs |
| `openbot-node` | No | Split only when Node needs an independent release/security boundary |
| `openbot-site` | No | Split only when the public website has an independent lifecycle |
| Upstream forks | No | Create a thin fork only after a spike proves a source patch is unavoidable |

This means the minimum repository count is **1**. The likely long-term count is **2** if the Node
daemon needs separate signing and releases. A documentation/marketing repository would be a third,
but it is not part of the product foundation.

## Workspace map

```text
openbot/
├── apps/
│   ├── web/                 # Web/PWA work, supervision and artifact interfaces
│   ├── desktop/             # Thin Electron client and packaged runtime lifecycle
│   ├── server/              # TypeScript product authority, API and trusted services
│   └── node/                # Replaceable execution-node daemon
├── packages/
│   ├── work/                # Temporal workflows and activities
│   ├── config/              # Node environment and native macOS configuration
│   ├── db/                  # PostgreSQL schema and migrations
│   ├── domain/              # Product entities
│   ├── protocol/            # Versioned Server–Node and event contracts
│   ├── provider-sdk/        # Execution provider interface
│   ├── employee-publisher/  # Retained publisher key and signed-package helpers
│   └── mcp-example/         # Retained MCP scaffold implementation
├── providers/
│   ├── docker/
│   ├── cua/
│   ├── lume/
│   └── coder/
├── deploy/
│   ├── server/
│   └── node/
├── docs/
├── tests/oracles/           # Frozen migration comparison inputs, never product runtime
├── .agents/                # Contributor navigation and repository skills
└── .github/
```

`apps/server` is the single TypeScript control plane. `npm run dev` starts `scripts/dev-server.ts`;
containers and the macOS arm64 Desktop payload use the same TS product entry and standalone Node.
The Server closure retains document/OCR dependencies.
Use the [development entry](../.agents/README.md) and [repository map](REPOSITORY_MAP.md) for current
code/consumer/check routes.

This is a responsibility map, not an exhaustive directory listing.
Server remains the only authority for identity, policy, routing, approvals and audit, regardless
of implementation language. Web consumes contracts; providers implement execution interfaces.
Keep application composition explicit and split existing modules only when the touched behavior
requires it. The office visualization remains a deferred optional plugin.

## Split criteria

Move Node into its own repository only when at least two of these are true:

- Node and Server require independent release trains;
- macOS signing/notarization cannot share the main pipeline;
- external provider maintainers need a narrower permission boundary;
- the protocol has backward-compatibility tests across multiple supported versions;
- users need to install Node without receiving Server/Web source or dependencies.

Until then, one commit should be able to update protocol, Server and Node together.
