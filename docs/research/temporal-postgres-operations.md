# Research: Temporal PostgreSQL persistence and operations

- Status: implementation qualification; no production/default selection
- Date: 2026-09-23
- Owner: OpenBot integrator
- Acceptance: run the existing public work journey against the released Server with PostgreSQL;
  recover engine history into fresh storage, then verify current domain authority and external facts.
- Boundary: trusted control/engine network only; no execution sandbox joins it. Engine recovery
  does not own product approvals, credentials, spend or final publication.

## Search and source evidence

Queries: official Temporal self-hosted deployment, SQL schema tools, PostgreSQL backup/restore,
GitHub `repo:temporalio/temporal is:issue is:open postgres schema`. Read the prior Temporal/SDK
qualification and public work integration in the reuse ledger before expansion.

- Temporal Server/admin tools1.32.0, commit `d94e34a1ebba5410a2e7d07119a76896909591aa`, MIT.
  Reviewed release notes, `config/docker.yaml`, embedded config, Docker target recipes,
  entrypoint, `tools/sql/main.go` and `handler.go`, PostgreSQL schema manifests and relevant test
  inventory. The actual image CLI reports1.32.0. The actual Server only warns when authorization is absent; `--allow-no-auth` acknowledges
  that warning, not an authentication boundary. This profile explicitly records that exception.
- Image manifests: Server `sha256:c3e752127759616bb1615e0f9ba0e21635aeb5fdeb922de4f371c350955f46ae`;
  admin tools `sha256:a9f84fb9a374b2374fe2e67c8efc0468ff3f1c66c8a0b14597ec86e349e62bca`.
- Official samples-server `f811a033a5e79402cab9f792cea132f50344bd17` (MIT), postgres Compose,
  setup/namespace scripts and README. Upstream calls these development/testing samples, not
  a complete production deployment. Use their released binaries/schema commands, not an entire
  copied service stack or an Elasticsearch/UI dependency that this journey does not require.
- Existing pinned PostgreSQL17.11-bookworm manifest
  `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`.
  Read PostgreSQL17 pg_dump, pg_restore, psql and ALTER DEFAULT PRIVILEGES documentation.
- Open reports #3383 (schema names), #4044 (partition support), #10236 (schema jobs under mesh
  mTLS), #8202 (deployment crash loop), #5729 (password characters) were identified, not reproduced.
  Use separate default databases, no mesh/partitions; preserve quoted/password-safe config.

Primary sources: [Server release](https://github.com/temporalio/temporal/releases/tag/v1.32.0),
[deployment](https://docs.temporal.io/self-hosted-guide/deployment),
[upgrades](https://docs.temporal.io/self-hosted-guide/upgrade-server),
[visibility](https://docs.temporal.io/self-hosted-guide/visibility),
[pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html),
[default privileges](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html).

## Choice and exact gap

Use the matching released Server/admin image and PostgreSQL plugin, not the CLI development
server. Keep history and visibility in two engine databases, separate from OpenBot's business
store. A narrow single-host Compose profile supplies fixed images, private network, loopback-only
frontend, persistent storage and explicit schema commands. Schema owner is separate from runtime;
runtime gets data privileges and no superuser/create-database/schema-creation rights. Schema
initialization is explicit and not a Server startup side effect. No product dependency switch,
extra message broker, general recovery abstraction or homemade schema migrator.

This qualification profile trusts its host/Docker administrators. Frontend authorization is
explicitly disabled only for this loopback/private-control reference; production auth/TLS,
credential rotation, HA and real deployment load remain gates, not claims. Untrusted Linux
execution belongs on a separately enforced network and credential boundary.

Back up only after stopping this profile's engine writers; use upstream pg_dump/pg_restore on
both engine databases and restore into new empty owned storage. Do not overwrite arbitrary
existing databases or claim two live database dumps are one distributed snapshot. Product DB,
artifact storage and external effects are NOT rolled back by an engine restore. Test an older
engine approval snapshot against a newer domain unknown-write fact: current control state must
force lookup, not a second POST. Arbitrary old full-product rollback can resurrect authorization
and needs recovery admission controls/reconciliation before execution; this engine-only exercise
is not that future S7 procedure.

## Incorporation and acceptance

The minimal Compose/schema topology is adapted from the pinned MIT sample; retain its complete
notice in deploy/temporal/THIRD_PARTY_NOTICES.md. No Server/SDK/SQL source copied or patched.
Root implements the thin profile/harness, runs actual public-work faults on it, records schema
versions and dump/restore evidence, and measures only the actual reference environment.
Upgrade policy follows adjacent supported releases with schema before Server; no in-place downgrade
or arbitrary-version compatibility claim. Worker code history replay is a separate gate.

Planned: absent schema refuses startup; runtime SQL role cannot DDL but normal history works;
server/container restart retains namespace and workflow; cold restore to a fresh volume retains
approval/unknown reconciliation and one real fake-service write; missing or too-old schema fails
startup. Upstream permits a schema newer than its binary; our maintenance preflight rejects
newer or malformed versions before running any schema write. Linux isolation design is parallel and does not prove a sandbox has already been installed.

### Reviewed maintenance constraints

The pinned embedded config interpolates `POSTGRES_PWD` in YAML quotes without escaping. Restrict
this reference to distinct random hexadecimal passwords (48–128 characters), validate before
Compose, and reject unsupported runtime passwords at container entry. Do not expose secrets in
CLI arguments or print resolved Compose configuration. The thin operator uses the official SQL
tool, not a second migrator: require stopped engine containers, preflight both databases, then
initialize only empty stores or explicitly update to history1.19/visibility1.14. `setup-schema`
alone does not reject existing stores and an unbounded update can silently accept a newer schema.
After upstream schema commands, revoke runtime writes on schema metadata. Default privileges are
needed for new engine tables but otherwise also make those metadata tables mutable. A failure
leaves the engine stopped; an interrupted initialization requires inspection, not a blind retry.
The operator is for a single trusted administrator with exclusive maintenance ownership, not a
cross-host migration lock. Concurrent administration and direct raw SQL tools are outside it.

The first actual Docker Desktop run exposed another deployment distinction: an internal-only
bridge did not publish the frontend mapping despite the Server listening on7233. Keep PostgreSQL
and schema tools on the internal control bridge, add a dedicated normal frontend bridge only to
the Server, and publish only IPv4 loopback. All engine services share one container, so explicitly
use127.0.0.1 as its membership/cluster address. The Server now has ordinary bridge egress; this is
not a network-denied execution sandbox. Reviewed Docker
[bridge behavior](https://docs.docker.com/engine/network/drivers/bridge/) and
[internal networks](https://docs.docker.com/reference/cli/docker/network/create/#internal).

## Local results (2026-09-23)

Eight actual public-work cases pass on the released PostgreSQL engine, including a cold snapshot
restored at older approval history while newer domain/external facts remain. The recovered task
keeps exactly5POSTs,1write,11fixture usage units and byte-verified CSV. Cancel-before-write after
SIGKILL of engine and database keeps3POSTs/0write/6units. Namespace identity survives a new volume.
Schemas are1.19/1.14; backup sizes in this run were66771/46258bytes. Container restart commands took
3.06seconds; that is not end-to-end recovery time, capacity or idle-cost evidence. The SQL runtime
cannot DDL/delete schema metadata. Existing initialization, newer operator versions and missing or
too-old Server schemas are rejected.26 unit checks pass. The eight-case development engine regression and `npm run check` also pass. Independent review
added rejection of paused/restarting/unknown engine states and cleanup continuation after a
per-project Docker timeout; both have regression coverage. The final eight-case PostgreSQL requalification also passes after these maintenance fixes.
All owned containers/volumes were cleaned; no user runtime database was read or changed.

Initial failures were a missing dynamic-config file and internal-only networking without published
host connectivity, followed by a case-sensitive diagnostic assertion. None was a successful recovery
result. They were corrected by a mounted empty defaults file, the documented frontend bridge and
exact schema-error matching. Schema binaries, application migrations and control authority were
not weakened to obtain the pass. Release-to-release upgrades/history replay remain untested.
