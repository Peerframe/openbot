# Server container

[English](SERVER_CONTAINER.md) · [简体中文](SERVER_CONTAINER.zh-CN.md)

The source-built Server image uses Node.js `24.21.0` LTS on Debian Bookworm slim, pinned to the
reviewed multi-platform digest in [the Dockerfile](../deploy/server/Dockerfile). The build uses
npm `10.9.9`, prunes the monorepo to the Server and its six internal runtime workspaces, and copies
only their compiled output, production dependencies, package metadata, and database migrations
into the final image. The official base retains its bundled npm and license notices.

This is a pre-alpha deployment baseline. Local arm64 Docker Desktop tests and separate native
Linux amd64 and arm64 jobs passed in [CI run 33938120773](https://github.com/yxflc11/openbot/actions/runs/33938120773).
Neither a local test nor a green
hosted run establishes general production or host-platform support. No registry image is published
by this workflow. The separately attested Worker runtime remains on Node `22.22.2`.

## Build and run from source

From the repository root, create `.env` from `.env.example` if it does not already exist. Set a
random `OPENBOT_OWNER_PASSWORD` of at least 15 characters and a separate random
`OPENBOT_POSTGRES_PASSWORD`. The current Compose file embeds the database password in a URI: use
a long random URL-safe value, such as 64 hexadecimal characters. Delimiters such as `/`, `?`, `#`,
`@`, and `%` require a separately reviewed encoding change. The development database default is
not a production secret. Protect `.env` and keep it out of version control.

```bash
docker compose --env-file .env -f deploy/server/compose.yaml config --quiet
docker compose --env-file .env -f deploy/server/compose.yaml up --build -d
docker compose --env-file .env -f deploy/server/compose.yaml ps
curl --fail http://127.0.0.1:3001/health
```

Stop an existing source-development Server before using the same port. Web and Worker services
are separate; this image does not include either client or a computer Provider. Both published
ports remain bound to loopback. Follow the existing private-network, TLS, cookie, and origin
requirements before connecting a remote client.

The Server runs as UID/GID `1000`, with a read-only root filesystem, a private 16 MiB temporary
filesystem, and an explicit writable object volume. PostgreSQL has its own persistent volume.
For an existing deployment, first back up both stores using [database operations](DATABASE.md).
An object volume written by the former root-running image may need an operator-reviewed ownership
migration to UID/GID `1000`. Existing volume ownership is not automatically changed; a new-volume
smoke test does not prove an existing-volume upgrade. Do not delete the volume to fix permissions.

```bash
docker compose --env-file .env -f deploy/server/compose.yaml stop
```

Compose allows 20 seconds for shutdown. The Server has a 10-second HTTP drain before final cleanup.
Current integration evidence covers a healthy, idle Server; startup interruption, busy dispatch,
and stalled database shutdown still need lifecycle tests. `/health` checks process identity and
startup completion, not continuous database readiness. PostgreSQL still uses a version tag rather
than an immutable digest, so the complete stack is not claimed to be byte-for-byte reproducible.

## Reproduce verification

Run `npm run server:container:check` and `npm run check` for the repository contracts. On each native
target, build with `docker build --platform linux/arm64 --tag openbot-server:smoke --file
deploy/server/Dockerfile .` (use `linux/amd64` on amd64), then run:

```bash
OPENBOT_TEST_IMAGE=openbot-server:smoke OPENBOT_TEST_PLATFORM=arm64 bash scripts/smoke-server-container.sh
```

Use `amd64` for the corresponding target. The smoke creates and removes only its temporary test
containers, internal network, and object/model volumes. It checks runtime architecture, non-root identity,
dependency inventory, missing-password rejection, the complete migration journal, health identity,
object persistence, migration idempotence, and zero-exit SIGTERM. It does not publish artifacts.

See [upstream research and remaining risks](research/server-node24-production-container.md).

## Persistent model settings

The default Compose deployment now mounts `openbot-model` at `/var/lib/openbot/model` and sets
`OPENBOT_MODEL_DIRECTORY`. On first startup the Server creates a private 32-byte encryption key;
encrypted provider settings are retained in the same private directory. No provider is enabled by
default. The Owner configures and explicitly enables it through Desktop settings after connecting.
The source-development `.env.example` uses `./data/model` for the same lifecycle.

Back up the **whole model directory**, including `encryption.key` and `settings.json`, alongside
PostgreSQL and objects. Protect that backup as a secret: keeping key and ciphertext together does
not protect against access to the entire directory. Restore with Server ownership and directory
mode `0700`, file mode `0600`. A missing key beside existing settings, malformed key, symbolic link,
or exposed Unix permissions prevents startup; restore the original key rather than deleting data.
The container restart smoke checks saved model settings using a fake provider, with no paid calls.

Existing Desktop-managed services retain their explicit `OPENBOT_MODEL_SETTINGS_PATH` and
`OPENBOT_MODEL_ENCRYPTION_KEY` bootstrap. Do not combine those two legacy variables with
`OPENBOT_MODEL_DIRECTORY`. Separate deployments may keep their existing explicit-key setup; there
is no automatic key migration or rotation. The plain key is readable only by the Server account,
not a renderer or Worker, and the settings API never returns it.

## Optional Python execution image

The migration also provides a `runtime-python` target: the same built Server and Node 24.21.0
with Python 3.12.13 and a strict runtime-only dependency lock. It excludes Python tests and pytest.
The unqualified Docker build and existing Compose command continue to select TypeScript.
To select the experimental Python loop explicitly, reuse the same `.env` and Compose project:

```bash
docker compose --env-file .env -f deploy/server/compose.yaml -f deploy/server/compose.python.yaml config --quiet
docker compose --env-file .env -f deploy/server/compose.yaml -f deploy/server/compose.python.yaml up --build -d
```

This overlay keeps the existing database, object and model volumes, loopback ports and read-only
filesystem. Server startup verifies the fixed interpreter and the complete installed dependency
profile before migrations or interrupted-task recovery; missing/drifted dependencies are fatal.
The Server still owns identity, credentials, approvals, budgets, audit and result publication.
An in-container Python subprocess has the Server OS user's access and is not an independent sandbox.

To return to the default executor, stop new work, let active tasks finish or cancel them, and rerun
the original Compose command with `up --build -d --force-recreate` and no Python overlay. Keep the
same project name, `.env` and volumes; do not use `down --volumes`. Switching images is not a
checkpoint migration or replay of interrupted external actions.

The optional image is verified by the same required native container CI matrix. Reproduce on the
corresponding architecture (replace `arm64` with `amd64` as needed):

```bash
docker build --platform linux/arm64 --target runtime-python --tag openbot-server:python-smoke --file deploy/server/Dockerfile .
OPENBOT_TEST_IMAGE=openbot-server:python-smoke OPENBOT_TEST_PLATFORM=arm64 OPENBOT_TEST_AGENT_RUNTIME=python bash scripts/smoke-server-container.sh
```

The smoke uses disposable data and an internal test network. It verifies a real Python SDK/tool
loop with Unicode arguments and synthetic Server ports, cancellation, runtime dependency inventory,
failed preflight before database changes, actual Server login/API, migrations, persistent storage,
restart and SIGTERM. It makes no real model calls. See [packaging evidence](research/python-server-container.md)
for actual local results and remaining platform limits; wiring CI does not mean a hosted run has passed.
