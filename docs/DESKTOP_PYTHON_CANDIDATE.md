# Desktop Python product development candidate

This explicit macOS arm64 Preview build starts the existing Python product API with a bundled, relocatable CPython distribution. It retains Desktop's PostgreSQL supervisor, encrypted bootstrap, Owner login and local data layout. Normal Desktop packaging and release assembly still select the existing backend.

This is an unsigned development candidate. The current page source `5b3f6bd` plus the fixed execution
configuration increment packages all45 canonical migrations and63 pinned dependencies. Fresh staged
and packaged tests passed actual API/PostgreSQL startup, Owner login, preserved data across restart,
parent-death cleanup, unsafe-directory refusal and refusal of execution configuration without an
engine. All163 Python source modules, lifecycle scripts, lock and SQL bytes match the checkout;
ASAR controller hashes identify the exact launcher increment. Two actual bundled Worker starts
connected to owned mTLS Temporal and accepted the fixed browser configuration. Malformed browser,
command and engine configuration each refused startup and cleaned PostgreSQL. Owned fixtures and
the engine were removed. [Current evidence](../experiments/work-journey/evidence/desktop-preview-schema45.json)
records the checks and exact hashes.

Earlier canonical41 native GUI/Keychain evidence and canonical44 packaging evidence remain pinned
to their original artifacts. The new native GUI check is pending: Computer Use timed out using both
the exact application path and verified bundle identifier, and Preview was absent from its app
inventory. Opening the new Preview locally is needed to resume that check. Complete packaged model
execution, signing and installation remain unqualified; normal packaging retains its original backend.

## Reproduce from a checkout

Use macOS arm64 with the repository's Node/npm requirements and Xcode Command Line Tools (`xcrun clang`). No system Python, maintainer venv, Docker daemon, paid model account or existing database is required. Public GitHub, nodejs.org and PyPI downloads must be reachable. Allow approximately 3 GB for staged runtime, Electron bundle and temporary copies. No paid service is used.

After applying this change and installing the repository lock with the normal contributor setup, run from the repository root:

```sh
npm ci
npx turbo run build --filter=@openbot/desktop... --filter=@openbot/db...
node apps/desktop/scripts/prepare-native-server.mjs --python-product
node apps/desktop/scripts/smoke-python-product.mjs apps/desktop/out/python-product-runtime
node apps/desktop/scripts/package.mjs --preview --python-product
node apps/desktop/scripts/smoke-python-product.mjs 'apps/desktop/out/python-product/OpenBot Preview-darwin-arm64/OpenBot Preview.app/Contents/Resources/native-runtime'
```

The staged runtime is `apps/desktop/out/python-product-runtime`; the uninstalled app is `apps/desktop/out/python-product/OpenBot Preview-darwin-arm64/OpenBot Preview.app`. Both are under the existing generated-output exclusion. `prepare-native-server.mjs` without the flag and all existing release commands retain their original selection. The candidate requires `--preview --python-product`; it refuses production signing configuration and a production Worker companion. `scripts/prepare-desktop-release.mjs` is unchanged and does not consume this local candidate.

A developer may then open the uninstalled Preview app and select the existing local Server setup flow. This uses that app's Preview profile; it is not the disposable smoke test. Do not point two Server instances at the same data directory. No environment switch can select an arbitrary interpreter or executable: a completed fixed-format resource manifest selects only the bundled backend.

## Fixed distribution and retained state

The builder verifies CPython 3.12.13 `python-build-standalone` release `20260807` and Node 24.21.0 archives against fixed SHA256 values, retains their notices, installs the exact existing 63-package `requirements-worker.lock` into standalone Python, checks that profile and `pip check`, then writes the opt-in manifest last. It copies Python product/runtime source and the retained PostgreSQL migrator/parser dependency closure. It does not package or start the TypeScript business Server. The build downloads code but does not start a service.

The launch environment is constructed from Desktop main's existing bootstrap and its explicit Desktop search opt-in; generic credentials and engine settings from the developer shell are not inherited. Secrets are passed in the child environment, never in arguments. `python -I -B` runs the fixed lifecycle entry. The Server binds to `127.0.0.1`; the existing Desktop Owner login completes readiness after a bounded JSON `/health` check for `python-product-candidate`.

Let `D` be Desktop's existing `<userData>/openbot/local-server` directory:

| Retained input/state | Python mapping |
| --- | --- |
| App-owned PostgreSQL and bootstrap database password | `OPENBOT_CONTROL_DATABASE_URL`; same cluster at `D/postgres`, no SQLite conversion |
| Bootstrap Owner password | `OPENBOT_CONTROL_OWNER_PASSWORD` |
| Loopback port and exact origin | `OPENBOT_CONTROL_PORT`, `OPENBOT_CONTROL_ALLOWED_ORIGINS`, `OPENBOT_CONTROL_COOKIE_MODE=loopback` |
| `D/model-settings.json` and bootstrap model key decrypted with existing safeStorage callbacks | Paired `OPENBOT_CONTROL_MODEL_SETTINGS_PATH` and `OPENBOT_CONTROL_MODEL_ENCRYPTION_KEY`; no `MODEL_DIRECTORY` selection |
| `D/objects/attachments` | Existing attachment layout below `OPENBOT_CONTROL_OBJECT_ROOT=D/objects` |
| `D/objects/plugins/state.json` | `OPENBOT_CONTROL_PLUGIN_STORE_PATH` |
| Explicit comma-separated `OPENBOT_PLUGIN_LOCAL_ENDPOINTS` from existing Desktop setup | Bounded retained list encoded as JSON for `OPENBOT_CONTROL_PLUGIN_LOCAL_ENDPOINTS`; Python remains endpoint/Owner authority |
| `D/objects/work-artifacts` | Private immutable control-owned files through `OPENBOT_CONTROL_ARTIFACT_ROOT` |
| `D/model-connections.key` | `OPENBOT_CONTROL_MODEL_CONNECTION_KEY_PATH`; Python creates a missing 32-byte private key only when its SQL rules permit |
| Optional owner-created `D/temporal.json` | Fixed `OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH`; absent means API-only, present must be private/owned/regular and pass Python mTLS configuration checks |
| Optional owner-created `D/browser.json` | Fixed `OPENBOT_CONTROL_BROWSER_CONFIG_PATH`; original enrolled Node routes, optional human control and trusted page origins; absent leaves Work browser routing disabled |
| Optional owner-created `D/command.json` | Fixed `OPENBOT_CONTROL_COMMAND_CONFIG_PATH`; existing protected-command installation, separate keys/pins and timing; absent leaves Work command execution disabled |
| Explicit `OPENBOT_DESKTOP_TAVILY_API_KEY` supplied to the Desktop process | Existing trusted launcher maps it to `TAVILY_API_KEY` for the Python Work web-search adapter; generic shell `TAVILY_API_KEY` is ignored |
| Bundled Node and parser dependency closure | `OPENBOT_CONTROL_NODE_EXECUTABLE`, `OPENBOT_CONTROL_NODE_MODULE_ROOT` |

The launcher creates missing private object subdirectories and rejects symlinks, noncanonical data paths, wrong owners or group/world access. It does not loosen permissions or replace existing files. PostgreSQL remains the product authority. It does not create a SQLite Runtime state store, a Temporal service or a sandbox. Model/provider credentials and inference remain controlled by the Python product service's explicit Owner settings. When the existing Work runtime is explicitly enabled below, its public-web tools support the retained Desktop Tavily opt-in. With no Tavily key, search is available only when the current selected model qualifies for the reviewed official Kimi adapter; other profiles retain public HTTPS fetch. Bundling these adapters does not itself start an engine or make a model call.

## Existing Temporal service: explicit opt-in

Without `D/temporal.json`, startup remains API-only: the bundle contains the Worker dependencies
but does not start the product Temporal Worker/ingress. To enable existing Work execution, first
provide a reachable **existing mTLS Temporal service**, namespace and Owner-controlled TLS files.
This candidate neither creates nor embeds another Temporal engine.

While the local Server is stopped, create `D/temporal.json` as a regular file owned by the current
user, with no group/world permissions (for example mode `0600`). It must contain 1–16,384 bytes; symlinks,
directories, empty/oversized or publicly accessible files are refused. The launcher accepts only
this fixed file below the already-private canonical app data directory. Renderer input and
`OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH`, `OPENBOT_DESKTOP_TEMPORAL_CONFIG_PATH` or generic Temporal
environment variables cannot select an alternate path. It never copies credentials or writes
this file for the user.

The existing Python schema is:

```json
{
  "temporal_address": "temporal.example.test:7233",
  "namespace": "openbot",
  "queue": "openbot-product",
  "tls": {
    "ca": "/absolute/owner-controlled/ca.pem",
    "certificate": "/absolute/owner-controlled/client.pem",
    "key": "/absolute/private/client-key.pem",
    "server_name": "temporal.example.test"
  }
}
```

These are placeholders, not a working endpoint or credentials. Python reopens the configuration
with `O_NOFOLLOW`, checks the actual file descriptor, applies its strict schema and reads the
Owner-controlled CA/certificate/private key. It requires mTLS and the configured server identity;
there is no plaintext fallback. The file cannot override the Desktop database, model selection,
interpreter or module. Optional existing bounded fields are `limit`, `execution_timeout_seconds`,
`item_timeout_seconds` and `interval_seconds`; the Python service validates their bounds.

A present invalid configuration or unavailable service fails local Server startup instead of
silently falling back to API-only. A valid connection starts the **existing** ProductWorkService,
SDK Worker and Work admission path. Model/tool authority still comes from the current Owner
configuration and Work Actions; no Worker Host/computer profile is newly qualified. Stop the local
Server before changing or moving the opt-in file. Configuration is read at startup, not watched.

The same fixed private-file checks now apply to `D/browser.json` and `D/command.json`, each
1–16,384 bytes and mode0600, with canonical owner-controlled parents. Generic shell variables
cannot select either path. Python rechecks the real file descriptor and strict schema; a malformed
present file fails startup rather than silently disabling it. No configuration or signing key is
created automatically. Configure browser routes using [the controlled-browser contract](CONTROLLED_BROWSER.md)
and command installation using [the existing command contract](WORK_COMMAND_READINESS.md).
Both execution paths require Temporal; commands also require their original enrolled Host and reviewed keys.
These mappings expose existing opt-in adapters; they do not qualify a new host or authorize input.
Stop the local Server before changing any of the three files.

Shutdown closes a private parent pipe and waits for Python's orderly exit before the existing controller stops PostgreSQL. Abrupt Desktop parent death also closes that pipe; a bounded hard exit covers a stuck Python shutdown. Failed startup reaps the API and database. The launcher uses no shell and has fixed preflight, migration and readiness deadlines.

## Verification and limits

The smoke script creates a new temporary canonical private directory, starts real bundled PostgreSQL and CPython, authenticates Owner, creates a channel, restarts, verifies unchanged encrypted-bootstrap bytes and connection key, lists empty nodes and plugins, and stops. A disposable launcher parent is killed to exercise actual API exit on pipe EOF. A symlinked artifact directory must fail startup and release PostgreSQL. All fixtures and children are removed; synthetic base64 encryption is used only in this test. It is not a native Keychain test.

The same smoke is run against the resource directory inside the produced `.app`, proving relocation without a host venv. This default smoke does not launch Electron UI or verify native safeStorage, code signing, notarization, OS permission prompts, installers, Linux/Windows bundles, model transmission or an actual mTLS Temporal execution path. A separate [packaged connection probe](../experiments/work-journey/desktop-temporal/README.md) passed against an owned mTLS PostgreSQL-backed Temporal service on 2026-09-25: two starts each exposed one fresh Workflow/Activity poller with the same Worker identity; normal stop, restart persistence, parent EOF, and invalid-config/unsafe-directory refusal all passed. The packaged controller/launcher bytes matched the compiled source. This proves real bundled Worker connection and lifecycle, while model execution and history replay are qualified separately by the product journeys, not by this package probe. The [public result](../experiments/work-journey/evidence/desktop-packaged-temporal.json) contains no credentials. Existing Python feature/support limits continue to apply. A release must separately qualify those product paths and include a reviewed signing/notarization strategy for every nested native runtime.

See [the research record](research/desktop-python-product.md) for exact upstream pins, sources, licenses and the reuse decision.
