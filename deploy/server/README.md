# TS product deployment

The default image contains the single `apps/server` control plane, built Web, canonical SQL
migrations and retained document/OCR libraries. Node 24.21.0 is the sole product process.
The explicit mTLS Temporal service, private storage and HTTPS configuration are required before
the API starts. PostgreSQL and Temporal remain separate services.

From a fresh checkout, build the shared packages and run the disposable qualification:

```sh
npm ci
npm exec -- turbo run build --filter=@openbot/server
docker build -f deploy/server/Dockerfile --target runtime-product -t openbot-server:candidate .
node deploy/server/smoke-product.ts openbot-server:candidate
```

The smoke owns random-name PostgreSQL/API containers, a PostgreSQL-backed mTLS Temporal fixture,
private TLS configuration and state volumes. It checks real HTTPS Owner login, built Web, all58
canonical migrations, one Node PID1, UID1000, read-only rootfs, dropped capabilities, session/channel
restart, original document bytes and the private model-key hash. Actual DOCX/PDF extraction and
blank-image OCR use the packaged parser and offline language data. Blank OCR proves initialization,
not recognition quality. Synthetic data and generated passwords stay within these disposable
resources; cleanup verifies ownership before deletion. Model calls are refused.

For an operator-reviewed deployment, select a new Compose project and retain paired database,
state/key and Temporal backups. Supply `OPENBOT_POSTGRES_PASSWORD`, `OPENBOT_OWNER_PASSWORD`,
`OPENBOT_TS_PUBLIC_ORIGIN` (an exact HTTPS origin) and `OPENBOT_PRODUCT_CONFIG_DIRECTORY` through
the trusted runtime environment. The configuration directory contains `server.pem`, `server.key`,
`server-ca.pem` and `temporal.json` plus the TLS files it references. Its private files must be owned
by UID1000 with mode0600. Use container paths in `temporal.json`, for example:

```json
{
  "temporal_address": "temporal.internal:7233",
  "namespace": "openbot",
  "queue": "installation-queue",
  "tls": {
    "ca": "/run/openbot/temporal-ca.pem",
    "certificate": "/run/openbot/temporal-client.pem",
    "key": "/run/openbot/temporal-client.key",
    "server_name": "temporal.internal"
  }
}
```

The Server derives its versioned TS queue from this installation queue and verifies the previous
SQL/Temporal execution history is drained before admission. It preserves SQL history and refuses
incomplete or unsafe configuration. Configure optional browser/command authority separately.

```sh
docker compose -p openbot-product-candidate -f deploy/server/compose.yaml build
docker compose -p openbot-product-candidate -f deploy/server/compose.yaml up -d
```

Compose publishes only127.0.0.1:3001 and keeps PostgreSQL private. The HTTPS certificate must match
the public origin. Host and Origin validation remain exact; cookies use Secure/HttpOnly/SameSite
and the `__Host-` name. The runtime uses UID/GID1000, a read-only rootfs and a128MiB private tmpfs.
The final dependency tree is projected from the reviewed npm lock. Web/compiler inputs remain in
the build stage; the runtime keeps the required Node, PostgreSQL and third-party notices.

Focused checks:

```sh
node --test deploy/server/product-container.test.ts
npm exec -- vitest run --config scripts/vitest.integration.config.ts scripts/product-entry.integration.test.ts
```

The first validates the lock projection, source closure, Docker/Compose configuration and migration
pin. The second checks real configuration parsing with synthetic database/Server adapters: invalid
inputs, storage refusal, canonical migration order, failed migration and undrained history. The
container smoke above is the actual process/HTTP/parser qualification. CI retains Linux amd64 and
arm64 jobs. Historical [Python image evidence](PRODUCT_CONTAINER_RESULT.json) and its
[research record](../../docs/research/python-product-container.md) identify their original artifacts;
current CI receipts identify the TS image under review.
