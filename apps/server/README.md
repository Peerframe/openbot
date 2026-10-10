# OpenBot Server

The [P5 TypeScript control plane](../../docs/decisions/0050-typescript-control-plane.md) owns public
HTTP, events, Worker connections and Work/Temporal execution in one process. It uses the existing
SQL history, document/OCR dependencies and protocol consumers. Commands preserve the reviewed
[installation boundary](../../docs/research/work-command-installation.md). There is no forwarding upstream,
operation-group selection or automatic fallback inside this service.

The Server requires the complete product configuration and a reachable Temporal service. From the
repository root, use .env.example and npm run dev:server for development. The deployment entry
is deploy/server/product-entry.ts: it validates private storage, runs canonical migrations and
refuses admission while legacy SQL/Temporal work remains open. Never point tests at user data.

Run the existing checks from the repository root:

```sh
npm run test --workspace @openbot/server
npm run test:integration --workspace @openbot/server
npm run test:control:ts
npm run test:work:ts
npm run contracts:http:ts
npm run contracts:http:tls
npm run ui:acceptance
npm run check
```

HTTP and HTTPS accept --suite all, models or publisher. The Vitest fixtures own their PostgreSQL,
Temporal, keys, files and subprocesses. Work scenarios exercise real control/engine/recovery paths
with synthetic model and effect peers; they do not qualify a native Linux sandbox or paid provider.
Native container/Desktop scripts separately verify packaging and lifecycle.

P5 is merged ([#222](https://github.com/Peerframe/openbot/pull/222)): Desktop packaging and
required CI use only this Server, and the Python control plane and harness are retired. The macOS
arm64 Desktop package bundles it with one standalone Node, which the Owner retained after the
Electron permission qualification failed. Installing or releasing a new Desktop build is a separate,
explicitly approved step. See the [architecture phase table](../../docs/ARCHITECTURE.md) for current scope.
