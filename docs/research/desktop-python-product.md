# Research: opt-in Desktop Python product candidate

- Status: Accepted and verified for a macOS arm64 unsigned development candidate; Electron UI/Keychain/signing qualification remains outside this result.
- Date: 2026-09-25
- Acceptance journey: build a separate opt-in Preview candidate, initialize an isolated app-owned PostgreSQL cluster, start the real Python product API, authenticate, stop/restart and retain the same data layout.
- Security boundary: Electron main owns paths, encrypted bootstrap and child lifetime. Python is the Server authority, not a sandbox. Renderer cannot choose an interpreter, path, credential or command. Existing data is never copied or migrated to SQLite. No installed app or actual user profile is touched by validation.

## Search evidence

Inspected existing native-server.ts, main.ts, prepare-native-server.mjs, package.mjs, package policy/resources tests, prepare-desktop-release.mjs, Python serve.py/environment locks, the reuse ledger and previous Desktop bootstrap, Python container and native lifecycle research. The current checkout has compiled Desktop JS and embedded PostgreSQL files, but no native-runtime directory or installed Electron dist. Electron dependency is 44.3.0; default package.mjs still selects 44.2.0. This candidate does not silently alter default release selection.

Official sources checked 2026-09-25:

- https://www.electronjs.org/docs/latest/api/utility-process — utilityProcess runs Node modules; it is not a Python interpreter launcher.
- https://www.electronjs.org/docs/latest/tutorial/asar-archives — executable resources belong outside ASAR.
- https://docs.python.org/3.12/library/venv.html — venvs generally cannot be moved/copied as portable distributions.
- https://docs.python.org/3.12/using/cmdline.html — isolated mode ignores Python environment/user site and removes unsafe initial path.
- https://github.com/astral-sh/python-build-standalone/releases/tag/20260807
- https://github.com/astral-sh/python-build-standalone/tree/00c8a06113f11220667c3bcf5fab1672ff9e78ef
- Pinned docs/running.rst, docs/distributions.rst, docs/quirks.rst, root python-licenses.rst and LICENSE component texts, test-distribution.py and open issues in that repository.
- https://nodejs.org/dist/v24.21.0/SHASUMS256.txt — exact existing reviewed Node runtime release.

GitHub queries included Python standalone CPython3.12.13 install_only/macOS relocation, distribution licensing, release assets and current issues. Current issues around Apple Silicon scheduling, libffi, PGO defaults and release signing do not change this unsigned fixed-input local candidate. Python3.12.13 is retained from existing OpenBot review; newer interpreter versions are not introduced.

## Candidate comparison

| Candidate | Pin/license | Fit and decision |
| --- | --- | --- |
| python-build-standalone install_only | CPython3.12.13+20260807, source commit 00c8a06113f11220667c3bcf5fab1672ff9e78ef; build scripts MPL-2.0, distributed Python PSF and bundled-component licenses | Select released relocatable install-only distribution. macOS arm64 gzip SHA256 4201588fc5051c2ba988abbe1f033d318965ee378fadf7fb7ef79882ba7be84b, 25168985 bytes. Keep all bundled notices. Test relocation and actual extension imports/API. |
| Host venv / system Python | No new pin | Reject for packaged use: private absolute paths and nonportable environments. A selected interpreter is allowed only as a development build/test tool. |
| PyInstaller/frozen app or CPython embedding | No dependency added | Extra freezer/import/native-wheel logic or application integration is unnecessary once the released distribution works. |
| Existing Electron utilityProcess alone | Electron44.3.0, MIT | Reuse for unchanged default Node backend. Cannot run Python and cannot use Electron-as-Node with existing security fuses. |
| Separate reviewed Node binary | Node24.21.0 darwin-arm64 gzip SHA256 bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057; Node and bundled licenses | Reuse only for original DB migration module and pinned attachment parser/codec dependencies. Do not start or package the TypeScript business Server entry point. |

## Reuse decision

Keep NativeServerController's PostgreSQL lifecycle, encrypted bootstrap, Owner credentials, local-server dataRoot, object/model paths and health/authenticated connection flow. Add one fixed-resource Python launcher selected by a candidate manifest. The candidate build is explicit and Preview-only; normal packaging/release selection stays unchanged and refuses an accidental Python marker. Existing exact lock traversal supplies the minimal DB/parser package closure; no new npm lock or authorization protocol.

Stage the standalone interpreter directly, install exact `requirements-worker.lock` wheels at its own site-packages, verify the full environment, and retain all licenses. Do not stage a venv. Stage app source, retained migrations, fixed launcher/migration scripts and parser dependencies outside ASAR. The Python process has an explicit environment and `-I -B`; secrets travel via inherited environment, never command arguments or logs. A fixed stdin lifecycle entry ends the API when its Desktop parent closes or exits; orderly Server shutdown precedes PostgreSQL shutdown. Readiness checks the actual Python product health phase and then existing Owner login. No new scheduler is introduced. Without the fixed private D/temporal.json opt-in, this remains API-only. With it, the launcher selects the already-reviewed ProductWorkService and SDK Worker against an existing explicitly configured mTLS Temporal service; it does not embed a Temporal engine.

SQL migrations use the already-reviewed `packages/db` migrator in a short bounded Node process, not a second migration implementation. PostgreSQL remains the product source of truth. Any optional SQLite execution evidence store is separate Runtime configuration and is not substituted for PostgreSQL or silently bootstrapped in Desktop.

## Source incorporation

No third-party executable source is copied or substantially adapted. Existing OpenBot packaging code is changed locally. Public upstream license texts are copied verbatim into `apps/desktop/resources/python-notices/NOTICES.txt` from the reviewed source commit, with source blob identities and digests in `SOURCE.json`. The complete collection preserves component notices absent from the install-only archive; it does not assert that every upstream component is linked into this target. Downloaded runtimes retain their original LICENSE and bundled notices; pinned source URLs accompany the candidate metadata. This work does not sign, notarize, publish, install or enable the default release. Windows and Linux bundled-Python Desktop support are not claimed.

## Verification plan

Unit tests for manifest/explicit environment mapping and fail-closed backend selection; fixed archive digest and package closure checks; actual relocated standalone imports and complete lock verification; real synthetic PostgreSQL and Python health/Owner API; stop, parent pipe EOF, startup failure and restart. Build a local unsigned candidate using existing Electron Packager/fuse/resource gates when available. Native Keychain/UI/signing and real Worker execution remain distinct acceptance items. Root owns Python serve.py environment bindings and final repository checks.

## Verification result (2026-09-25)

- 59 targeted Desktop tests and eight unchanged release-assembly tests passed; Desktop TypeScript build and changed-file Biome checks passed.
- The exact downloaded standalone interpreter passed the then-current 59-package worker lock (the current lock contains 61 distributions after the reviewed public-web dependencies) and pip dependency checks. No host venv was copied.
- The real synthetic PostgreSQL/Python smoke passed against both staged resources and the completed app resource directory: Owner login, channel creation, restart retention, key permissions, empty nodes, plugin API, normal stop, actual parent EOF and poisoned-directory failure cleanup.
- Electron44.3.0 Preview packaging completed with existing ASAR/resource/fuse checks. Packaged main, controller and launcher bytes match compiled source. Python/Node license notices remain present and the TypeScript business Server entry is absent.
- The final bundle was built but not installed or launched as an Electron app. The smoke uses synthetic encryption only. There is no claim of native Keychain/UI/signing, Windows/Linux bundled Python, inference, Temporal dispatch or Worker execution acceptance.
- Candidate outputs live under the existing ignored `apps/desktop/out` tree; default release assembly remains unchanged.


## Fixed local Temporal opt-in follow-up (2026-09-25)

The current 61-distribution bundle already includes the product SDK Worker, but the original
explicit environment filter did not expose its trusted configuration entrance. Reuse a fixed
`D/temporal.json` under the existing canonical private Desktop dataRoot. Only an Owner-created
regular, non-symlink, current-UID-private file of 1–16,384 bytes is mapped to
`OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH`. Absence preserves API-only startup; an unsafe or invalid
present file fails startup. No renderer or ambient generic/desktop Temporal path variable is
accepted. The launcher does not create the file, credentials, service or model configuration.

Reviewed current sources: NativeServerController bootstrap/search filter, python-server.ts,
main.ts, fixed parent-pipe entry, Python serve.py, ProductWorkService.configuration and
work_engine_client.read_owned_file/tls_config. Rechecked the existing Node24.21.0 primary
[fs documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromiseslstatpath-options)
for lstat/Stats metadata. No dependency, framework or third-party source is added. The existing
Python O_NOFOLLOW/fstat reader and strict engine schema remain the final content/mTLS authority;
the Node check is preflight only and is not a cached permission. CA/certificate/private-key
paths and address/namespace/queue stay in that existing trusted schema. No database, model,
interpreter or module selection is added.

Existing Desktop search support is also retained: only explicit
`OPENBOT_DESKTOP_TAVILY_API_KEY` is projected as trusted `TAVILY_API_KEY`; the restored Python
WorkWebAdapter consumes it when ProductWorkService is configured. Generic shell Tavily keys
are not inherited. Without Tavily, the reviewed official Kimi search conditions still apply;
public HTTPS fetch remains available independently of a search provider.

Follow-up tests use temporary private directories and launcher environment projections only.
They do not launch/replace an installed app, modify Keychain/user data, create a Temporal server,
or establish packaged mTLS execution acceptance. The integrating root owns the final Preview
build and packaged/default and explicit-engine smoke. All original distribution notices remain.


## Packaged Desktop mTLS Worker smoke

Date: 2026-09-25. Scope: disposable acceptance probe only; no product, builder, launcher,
installed app, Keychain, user-data or engine change.

Reuse the existing OpenBot `apps/desktop/scripts/smoke-python-product.mjs` lifecycle,
`NativeServerController`, `launchPythonProductServer`, fixed private `D/temporal.json`, and
the bundled `work_engine_client` mTLS reader/connector. Existing review entries are
`docs/research/desktop-python-product.md`, `docs/research/temporal-postgres-operations.md`
and `docs/OPEN_SOURCE_REUSE.md`. The input tree is HEAD
`482bdc5bea56c5b1a996492701b6dbb012d5691e` plus root's current reviewed migration changes.
Original smoke SHA256: `0b5571b3213adc883870ec99f9202d842b37b4d2e6b29a6c117bb8d0f9a455aa`.
Launcher SHA256: `d7bd8a636193d6f6e1c72ddfc000c4c003cb7df1c2ddad5b441fccf527df3db6`.

The successful public health response does not contain Worker state. Root explicitly retained
that contract. Therefore HTTP 200 is insufficient: use the same bundle's Temporal Python
1.33.0 SDK to read DescribeTaskQueue for both Workflow and Activity. Inspected the installed
released `temporalio/api/workflowservice/v1/request_response_pb2.pyi`, taskqueue PollerInfo
protobuf fields, SDK service call and product_worker composition. This reuses the released
protocol; it does not create Workflow/Activity or authorize an effect. On a unique probe queue,
both poller types must have the same single identity with last_access_time at or after the
current launch timestamp. Restart uses a new timestamp; historical pollers are not asserted
to disappear on shutdown.

No new dependency or third-party source is introduced. Existing exact CPython 3.12.13,
Temporal Python 1.33.0 and Node 24.21.0 pins remain. Node's official
[FileHandle read/metadata documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html)
was rechecked for bounded descriptor reads; the child_process documentation URL was
unavailable, so the unchanged reviewed fork/IPC lifecycle is reused from the existing smoke.
This packet substantially adapts the MIT OpenBot smoke; the original LICENSE is retained.

Alternatives rejected: a successful health request alone can silently accept API-only;
changing health solely for the probe expands the public contract; patching model transport
inside bundle tests different bytes and adds inference/Replay scope. This probe tests the
unmodified packaged launcher and Worker connection, not complete model execution.

The CLI accepts explicit runtime, compiled Desktop-dist and private trusted existing engine
config paths. It preserves namespace/TLS and rewrites only queue to a fresh random queue in
the disposable D. It never emits config, credentials, process stderr, original poller identity
or private paths. All writes and the synthetic encrypted bootstrap remain inside a fresh
temporary root. It launches no Temporal server and does not copy private key bytes.

Required acceptance: actual packaged Python/PG starts, synthetic Owner auth works, both
fresh pollers appear, normal stop removes API/PG, restart preserves synthetic data and
produces fresh pollers, disposable parent EOF stops API, invalid private JSON refuses startup
and cleans PG, original poisoned artifact-directory failure remains fail-closed. Tests of
the probe itself must be labeled synthetic; root runs the actual packaged acceptance.


### Final packaged execution evidence

The actual unsigned macOS arm64 app was rebuilt with all 61 pinned Worker packages.
Both staged and packaged API-only smoke passed. The separate packaged Temporal smoke
then passed twice against an owned PostgreSQL/mTLS engine: one fresh common Workflow/
Activity Worker identity per start, Owner login, retained bootstrap/channel/key, normal
stop, parent EOF, invalid private configuration and unsafe-directory refusal with PG
cleanup. The owned engine was removed. Probe input/unit checks passed 9 Node plus 7
actual-protobuf/synthetic-RPC cases. Initial unprivileged socket attempts were rejected
by the execution sandbox; the authorized local-port runs above are the successful evidence.

The ASAR controller/launcher match the compiled source exactly. All 128 control source
files, 12 Runtime source files and 42 migration assets match the working tree byte-for-byte.
Public digests and booleans are in experiments/work-journey/evidence/desktop-candidate-provenance.json
and desktop-packaged-temporal.json. The parent commit is 482bdc5, not a commit of the
uncommitted candidate. No installed application, real Keychain or real account was changed.
Packaged inference, replay, signing and Linux/Windows support remain unclaimed; composed
product inference uses separate synthetic transports and actual SDK history replay.
