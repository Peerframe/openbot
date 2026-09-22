# Fresh contributor journey

[简体中文](CONTRIBUTOR_JOURNEY.zh-CN.md)

From a fresh checkout, the existing smoke starts the actual Server/Web development commands,
checks the proxy and Owner login, restarts them and verifies the retained Owner session. Its optional
Node path exercises real enrollment and reconnect using the production file credential adapter.
No model key, configured Provider, installed app profile, private dotenv or personal account is used.

## Run

Use a fresh checkout/worktree with Node supported by `package.json`, npm, Docker, and free ports
3001 and 5173. On Linux/macOS:

```sh
npm ci --ignore-scripts
npm run dev:smoke
```

To include the Node journey, use this command **instead of** the last one:

```sh
npm run dev:smoke -- --with-node
```

The first run may download the pinned PostgreSQL 17.11 image. The driver creates a container with a
random name, a private ownership label, a random loopback port, synthetic credentials and tmpfs data.
It verifies ownership before removing that container. Existing containers are not stopped or reset.

Run this before `build`, `test`, or `check`: Turbo's prerequisite builds are part of the acceptance.
The driver refuses existing workspace `dist` directories or local root/Web `.env*` files (except
`.env.example`). It never deletes those files to make the check pass. A completed run leaves normal
ignored development build/cache output; use another fresh checkout to repeat the cold-start check.
The smoke verifies HTTP behavior, not rendered-browser or native-platform behavior.

## What is verified

1. The real `npm run dev` builds shared dependencies, starts Server/Web and serves the Vite entry,
   direct Server health and proxied health.
2. Anonymous workspace access returns 401. Synthetic Owner login through the proxy produces a
   cookie that can access the session and authenticated workspace API.
3. With `--with-node`, the Owner issues one bound enrollment token and `npm run dev:node` consumes
   it through the production client. The Server reports the Node active/connected, with no Provider
   capabilities. Its private identity file matches the Server's enrollment timestamp; token replay
   returns 401.
4. The Node stops and is observed disconnected. Server/Web restart against the same private fixture
   state; the original Owner cookie remains valid without a second login.
5. With `--with-node`, a new Node process starts with the retained identity file and **no** enrollment
   token or environment credential. The Server sees it connected under the same enrollment, and the
   complete identity file's SHA-256 digest remains unchanged.
6. The driver terminates only its process groups, removes its private temporary directory and removes
   its labelled database container. Interruption and failure take the same cleanup path.

No task is submitted and no Provider capability is exercised. Enrollment/reconnect evidence does
not establish native Worker Host installation, keyring protection or computer-control support.

## Existing CI database

The existing disposable database job may supply `OPENBOT_DEV_SMOKE_DATABASE_URL` instead of Docker
creation. It must be a single loopback PostgreSQL URL without parameters, name an empty database
ending `_dev_smoke`, and contain no existing application tables. The driver checks this before
migration and never resets nonempty state.

The caller owns this explicitly supplied database and is responsible for disposing of its service.
The driver does not drop it or reset its generated schema/data. Temporary credentials/files and
child processes still belong to the run and are removed. CI should run `npm run dev:smoke --
--with-node` after `npm ci` and before the first build in that job. A database already used by a smoke
must not be reused as a fresh fixture.

## Failure diagnostics and focused checks

Progress messages name the current phase. A failure reports the missing service or failed HTTP/
identity invariant and prints bounded child diagnostics with fixture passwords, database URLs,
cookies and Node credentials removed. Docker failures never print command arguments containing the
synthetic password. Occupied development ports fail before creating a database or starting a process.

```sh
node --test scripts/smoke-dev-fixture.test.mjs
npm run check
```

The fixture tests cover target validation, fresh-checkout refusal, isolated child environments,
redaction, identity-file constraints, port ownership and process cleanup. They do not replace the
real smoke. The process-group driver is explicitly Linux/macOS-only; Windows needs separate native
process-tree acceptance before this command can claim support.

See the [fixed-version research and verification scope](research/2026-09-22-contributor-journey.md).

## Local acceptance evidence — 2026-09-22

The complete `--with-node` journey passed on macOS arm64 using Node 26.0.0, npm 11.12.1 and the
pinned PostgreSQL Docker image. This includes every default-path assertion and the optional Node
assertions. All seven focused fixture tests and `npm run check` passed. A separate clean fixture was
interrupted with SIGTERM after the database and development process started: the driver exited
nonzero with the failing stage, and no smoke temporary directory, owned container or listener on
3001/5173 remained. This is local evidence; the existing hosted Node 22/npm CI pins were not changed
or independently executed by this work package.
