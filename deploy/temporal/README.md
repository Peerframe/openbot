# Temporal PostgreSQL qualification profile

[English](README.md) · [简体中文](README.zh-CN.md)

This explicit single-host reference uses released Temporal Server/admin-tools **1.32.0** and
PostgreSQL **17.11**, pinned by image digest. It qualifies engine persistence for the
[public work journey](../../experiments/work-journey/README.md); it does not enable a production
dispatcher or change OpenBot's default backend. [Source and decision](../../docs/research/temporal-postgres-operations.md).

## Boundary

Engine history and visibility live in two databases on their own PostgreSQL instance. Neither is
OpenBot's authority database. The runtime SQL role has data privileges; the bootstrap/schema owner
is an administrator. Runtime cannot create schema objects or write schema version/history metadata.
Upstream SQL tools own migrations. Startup never initializes or upgrades the schema.

Only the gRPC frontend is published, on host IPv4 loopback. Database and internal service ports
are not published. This profile deliberately has **no frontend authentication/TLS**: it trusts all
host users and Docker administrators with access to that endpoint/network. Keep untrusted tools,
execution sandboxes and unrelated clients away. Do not expose it publicly or use it as the target
production security configuration. Docker socket administrators can inspect container credentials.

## Reproduce the acceptance

Use the separate Python experiment environment described in the journey README, Docker Compose,
and already-built repository dependencies:

```sh
/tmp/openbot-work-reference/bin/python -B -m unittest discover -s experiments/work-journey -p 'test_*.py' -v
/tmp/openbot-work-reference/bin/python -B experiments/work-journey/probe.py --engine postgres
```

The runner creates random project names, private temporary credentials and new named volumes. It
initializes matching schemas, verifies SQL permission failures, runs the public journeys, restores
an older engine snapshot into another new volume, and removes only its owned resources in `finally`.
It never opens an existing user database. Abrupt host/power loss may require cleaning the exact
`openbot-temporal-qualification-*` project reported by Docker; never use a global prune.

## Manual schema inspection

A trusted operator can retain a private reference instance. From repository root, create a **new**
credential file outside the repository; the example intentionally refuses to overwrite it:

```sh
python3 - <<'PY'
import os, secrets
path = '/tmp/openbot-temporal-reference.env'
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    stream.write('OPENBOT_TEMPORAL_SCHEMA_PASSWORD=' + secrets.token_hex(32) + '\n')
    stream.write('OPENBOT_TEMPORAL_RUNTIME_PASSWORD=' + secrets.token_hex(32) + '\n')
    stream.write('OPENBOT_TEMPORAL_PORT=7233\n')
PY
docker compose --env-file /tmp/openbot-temporal-reference.env --project-name openbot-temporal-reference --file deploy/temporal/compose.yaml up -d --wait postgresql
python3 deploy/temporal/maintain.py initialize --env-file /tmp/openbot-temporal-reference.env --project openbot-temporal-reference
docker compose --env-file /tmp/openbot-temporal-reference.env --project-name openbot-temporal-reference --file deploy/temporal/compose.yaml up -d temporal
```

Use distinct random hexadecimal credentials (48–128 characters). The pinned upstream embedded
YAML template does not escape arbitrary password characters; `start.sh` rejects unsupported values
before invoking the unchanged upstream entrypoint. Do not print resolved Compose config, commit the
file or pass passwords as command-line flags. Rotation needs an explicit database/config procedure;
changing the env file alone does not change an existing PostgreSQL role password.

Maintenance assumes **one exclusive administrator**. Stop workers and the engine first. `initialize`
requires both stores empty before writing either; it cannot be used to upgrade an existing database.
`upgrade` preflights both version records, rejects newer/malformed versions, invokes the matching
SQL tool with explicit history **1.19** / visibility **1.14** targets, verifies both results and
revokes runtime metadata writes. A failure leaves the engine stopped; inspect a partially changed
schema before retrying. Do not invoke `schema.sh` or the raw tools to bypass these checks.

```sh
docker compose --env-file /tmp/openbot-temporal-reference.env --project-name openbot-temporal-reference --file deploy/temporal/compose.yaml stop temporal
python3 deploy/temporal/maintain.py upgrade --env-file /tmp/openbot-temporal-reference.env --project openbot-temporal-reference
```

This release verifies a same-version maintenance run and rejection boundaries. It does **not** yet
qualify a release-to-release upgrade, worker-code change or rollback. Follow Temporal's supported
adjacent-release policy, review/pin the new images and schema first, and run history replay plus
restored-work journeys before changing the reference. The Server itself accepts some newer schemas;
our operator rejects newer versions rather than claiming universal binary/schema mismatch rejection.

## Restore semantics

The test stops engine writers before `pg_dump --format=custom` of both engine databases, records
size/SHA-256/schema/namespace identity, then restores with `pg_restore --exit-on-error` into **new
empty storage**. It recreates roles/grants from this profile and reseals schema metadata privileges.
The hash is an integrity check for this trusted local test, not authenticated backup provenance.

Product state, artifact files and external receipts are deliberately **not rolled back**. The test
restores history saved while approval was pending after a write has actually happened and become
unknown in the newer product state. Recovery must query the receipt, keep current authorization and
budget, and publish verified bytes without another write. This is engine-only restore qualification,
not an atomic full-product backup or disaster-recovery service.

Production auth/TLS, supported version upgrades and history replay, retention/archival, HA, storage
failure, workload/idle cost, credential recovery and full product restore remain separate gates.
A full product rollback can resurrect old grants and requires an execution hold and reconciliation.
No native Linux isolation or real-provider quality claim follows from this profile.
