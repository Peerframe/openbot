# Python product container candidate

This separate candidate packages the real Python product API, built Web, retained PostgreSQL
migrator and document parsers. It does not use the retiring TypeScript business Server or test oracle.
The existing Dockerfile/Compose defaults are unchanged.

**The actual Linux arm64 image and disposable-container qualification passed on 2026-09-25.**
Real Owner HTTP, built Web, all 43 canonical migrations, DOCX/PDF extraction, blank OCR
initialization, original attachment/key/schema persistence and SIGTERM stop/restart passed.
Four invalid-startup cases failed before schema creation; all owned resources were removed.
The [bounded result and source hashes](PRODUCT_CONTAINER_RESULT.json) identify the exact image.
This is a local Docker VM run; native Linux amd64 CI, configured Temporal and deployment remain
separate gates.

`serve.py` accepts only `OPENBOT_CONTROL_HOST=127.0.0.1` or `0.0.0.0`, with127.0.0.1 as the
unchanged default. An invalid value fails before database, key or model initialization. This
explicit image selects0.0.0.0; neither origins, cookies nor proxy trust changes automatically.

To reproduce from the repository root:

```sh
docker build -f deploy/server/Dockerfile.product --target runtime-product -t openbot-python-product:candidate .
python3 deploy/server/smoke-product.py --image openbot-python-product:candidate
```

The smoke creates only random-name disposable PostgreSQL/API containers, an internal network and
one owned state volume, then removes those exact resources. No existing database, Docker socket
mount, SSH, paid provider, Temporal engine or user data is selected. It checks real Owner HTTP,
real built Web, all43 canonical migrations, Office/PDF extraction and blank-image offline OCR
initialization, original attachment/key/schema persistence and SIGTERM stop/restart. Blank OCR
checks engine/language loading, not recognition quality. The Uvicorn0.53.0 implementation restores
and re-raises SIGTERM after shutdown, so the smoke accepts exit0 or143, never forced-kill137.
Missing password, invalid origin/Temporal path and hidden Python dependencies must fail before
creating the migration schema. The recorded run used this script against the actual image.

For an explicitly selected deployment candidate, use a new Compose project and new named volumes;
this is not an in-place old-volume upgrade instruction. Supply `OPENBOT_POSTGRES_PASSWORD` and
`OPENBOT_OWNER_PASSWORD` through your trusted runtime environment, never Docker build arguments:

```sh
docker compose -p openbot-python-product-candidate -f deploy/server/compose.product.yaml build
docker compose -p openbot-python-product-candidate -f deploy/server/compose.product.yaml up -d
```

Compose publishes only127.0.0.1:3001; PostgreSQL is not published. Defaults allow exactly the two
localhost Web origins and loopback cookies. Explicitly configure secure cookies/origins for a
separately reviewed HTTPS deployment; selecting a container listen address does not change those
policies or add proxy trust. Server runs as UID/GID1000 with read-only rootfs, a128MiB private noexec
tmpfs and `/var/lib/openbot` persistent state. Keep database and state/keys paired in backups.

Without `OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH`, this is API-only. To opt in, supply an existing
mTLS Temporal service and mount its explicit configuration/certificate/key files read-only via a
separately chosen Compose override. Config and private key must be owned by UID1000 and0600;
all referenced paths are container paths. Set that single explicit variable on the Server service.
The retained ProductWorkService reads/validates them and starts its existing Worker. There is no
embedded engine, plaintext fallback or automatic command/browser capability. Other trusted
optional Control settings remain explicit runtime composition; no credentials are baked in.

Dependencies are the existing63-distribution Worker profile (including pytest/dev helpers) and
43 locked Node parser/DB entries before platform filtering. This is not a newly minimized Python
profile. Node24.21.0 and Python3.12.13 use existing exact official Bookworm image digests;
build-only Web/TypeScript dependencies never enter the final image. Package notices, Node license,
Python/component notices and THIRD_PARTY_NOTICES remain included. Build uses wheels only and
fails when a pinned architecture lacks one. The local Linux arm64 image passed; native Linux amd64/arm64 CI results are recorded separately.

Local focused checks (no Docker or provider):

```sh
node --test deploy/server/product-container.test.mjs
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=apps/server-python/src:apps/agent-runtime-python/src apps/server-python/.worker-venv/bin/python -m pytest -p no:cacheprovider -q deploy/server/test_product_container.py apps/server-python/tests/test_entry.py
```

See [research and exact boundary](../../docs/research/python-product-container.md).
