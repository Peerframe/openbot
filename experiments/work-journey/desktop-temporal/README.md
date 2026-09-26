# Packaged Desktop Temporal connection probe

[English](README.md) · [简体中文](README.zh-CN.md)

This disposable probe reuses the existing compiled `NativeServerController` and
`launchPythonProductServer`. It does not build, patch or copy product resources, start a
Temporal server, submit a Task, call a model, touch Keychain or use a real Desktop dataRoot.
The existing API smoke's synthetic safeStorage callbacks and actual PG/parent-pipe lifecycle
are retained.

## Run after the root's final build

Use a reviewed macOS arm64 Python candidate. `--runtime` must be the finished app's
`Contents/Resources/native-runtime` (or the staged native-runtime for a separate staged run).
`--desktop-dist` is the matching compiled `apps/desktop/dist` directory; the integrator must
check that its controller/launcher bytes match the packaged ASAR files, as in the original
packaging acceptance. Normal Node cannot import JavaScript directly from ASAR.

```sh
node experiments/work-journey/desktop-temporal/smoke-packaged-temporal.mjs \
  --runtime /absolute/candidate.app/Contents/Resources/native-runtime \
  --desktop-dist /absolute/checkout/apps/desktop/dist \
  --temporal-config /absolute/private/existing-engine.json
```

The last argument must be an existing current-UID private regular JSON file, 1–16,384 bytes,
with the already-supported `ProductWorkService.configuration` schema:

```json
{
  "temporal_address": "127.0.0.1:7233",
  "namespace": "existing-disposable-test-namespace",
  "queue": "replaced-by-random-probe-queue",
  "tls": {
    "ca": "/absolute/owned/ca.pem",
    "certificate": "/absolute/owned/client.pem",
    "key": "/absolute/private/client-key.pem",
    "server_name": "temporal.example.test"
  }
}
```

These are placeholders. Supply the already-running authorized mTLS test server and existing
namespace. The probe neither registers a namespace nor creates a server. Existing optional
bounded config fields remain unchanged. It changes only `queue` to a random UUID queue,
writes that JSON into private temporary `D/temporal.json`, and reads the original TLS paths
through the existing Python mTLS adapter. The input file and all TLS files remain unchanged.
No secret bytes or config contents are logged or put in process arguments. The smoke clears
the unrelated inherited Tavily/plugin endpoint projections before passing the synthetic
controller environment to the original launcher.

## Acceptance and result

On both first start and restart, the actual `/health` must succeed and synthetic Owner login
must work. Then **the bundle's own Python and Temporal SDK** connect independently using the
same private config. The helper issues only bounded, non-retrying DescribeTaskQueue reads;
it does not poll for work or start a Worker. Both Workflow and Activity poller records must
contain exactly one fresh identity, the same for both types, with last_access_time at or
after the current start's wall-clock timestamp. Only its SHA256 is returned. This requires
the existing server clock to be aligned with the host; a clock discrepancy fails the probe.
Cached pollers from earlier starts are ignored, and disappearance after stop is not asserted.

The synthetic channel, bootstrap and raw model-connection key must survive restart. Both
normal stop and killing the disposable launcher parent must close the actual API; the PG
PID and lockfile must disappear. A private nonempty JSON file with an invalid product
configuration then must fail the original Python startup, never authenticate or fall back
to API-only, and release PG. The original poisoned-artifact-directory check is also retained.
An invalid engine configuration generally prevents the HTTP socket from opening; the probe
does not require a 503 response from an app that never completed startup.

Success prints one public JSON record with format
`openbot.desktop.packaged-temporal-smoke/v1`, `connectedStarts: 2`, two poller observations,
and boolean lifecycle results. Failure prints only a fixed stage such as
`initial-launch`, `initial-fresh-pollers`, `restart-fresh-pollers` or `invalid-private-config`.
Child stderr, bootstrap, cookies, exact Worker identities and private paths are suppressed.
Cleanup always calls the original controller stop and removes the fresh temporary data tree.

This establishes connected product Worker startup and lifetime using an unmodified bundle.
It deliberately reports `fullInferenceVerified: false`, `workflowReplayVerified: false`,
`nativeKeychainVerified: false`; no native Electron UI, signing, Linux/runsc or OS execution
acceptance is implied. The random unused task queue may remain in Temporal's transient
poller cache; no Workflow history is created by this probe.

## Probe-only checks

The latest canonical43/63-package artifact passed the actual connected probe on2026-09-25;
[public evidence](../evidence/desktop-packaged-temporal.json) records its ASAR/controller hashes
and160 Python source files matching the current checkout. The earlier native GUI/Keychain
qualification belongs to its original artifact and is not implied by this connection probe.

```sh
node --test experiments/work-journey/desktop-temporal/probe-support.test.mjs
apps/server-python/.worker-venv/bin/python -B -m pytest -q \
  experiments/work-journey/desktop-temporal/test_observe_pollers.py
```

Those checks use synthetic files and real SDK protobuf types with synthetic service responses.
They do not count as an actual packaged connection. The root runs and retains the final
successful CLI JSON after rebuilding the candidate. No repository patch is needed.
