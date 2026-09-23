# Research: opt-in Python Server container

- Status: Accepted; local packaging and lifecycle checks passed
- Date: 2026-09-23
- Owner: OpenBot maintainers
- Acceptance journey: Build the existing Server with its installed Python execution package,
  start against disposable PostgreSQL, execute a synthetic tool loop and cancel it, then restart
  and stop with persistent data intact.
- Security boundary: Server retains all authority and credentials. Python is a supervised child
  inside the same container, not a separate sandbox. No live provider or published image.

## Search evidence and candidates

Reuse the completed [Server container](server-node24-production-container.md),
[runtime activation](python-runtime-activation.md) and Python SDK/schema dependency reviews.
The reuse ledger marks the existing Server image reviewed. Searches on 2026-09-23:
`site:github.com/docker-library/python 3.12 slim bookworm venv`,
`repo:docker-library/python is:issue is:open bookworm`, Docker multi-stage COPY documentation,
and Python 3.12 venv portability documentation.

| Candidate | Exact pin and license | Evidence and decision |
| --- | --- | --- |
| Official Python Bookworm image plus existing Node binary | Python 3.12.13, docker-library/python `3362634339580d3232e65a66dd5a36c47ae7ff14`, image-source MIT / interpreter PSF / Debian component licenses | Select. Same glibc distribution as reviewed Node 24.21.0. Dockerfile checks the interpreter, verifies its source, retains discovered shared libraries and supplies origin-relative libpython rpath. Previous amd64 paired acceptance passed on this base. Native arm64 execution still needs this slice's evidence. |
| Copy Python alone into the Node image | Same interpreter | Reject partial interpreter/library copying; it loses the official image's resolved native-library closure. |
| Host venv, system apt Python, new uv/build framework | No new pin selected | Host environments are not portable; system Python changes the reviewed version. Additional packaging frameworks are unnecessary for the existing fixed entry point and locked pip closure. |

The official image index is
`sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2`;
manifest inspection confirms amd64 `6e13e65c55e33adf203d77ee371cf8bf5d81bd4902ef07565721f46bf44917af`
and arm64 `3f9c7f75b916e8279e24136d7a57769aba9e193715be52570417698c52d6eed0`, both referencing
that source commit. Keep the existing Node 24.21.0 index and npm 10.9.9 pins. No version upgrade.

Read the [pinned Dockerfile](https://github.com/docker-library/python/blob/3362634339580d3232e65a66dd5a36c47ae7ff14/3.12/slim-bookworm/Dockerfile)
and LICENSE; reuse its existing interpreter/version checks and OpenBot's prior real Linux tests.
[Issue #1023](https://github.com/docker-library/python/issues/1023) documents sdist/build-tool drift;
install only binary wheels from exact pins and fail the build if a supported architecture lacks one.
This avoids silently adding a compiler or floating build backend.
[Python venv documentation](https://docs.python.org/3.12/library/venv.html) states that environments
are not generally relocatable. Create ours at its final absolute path using the same immutable
Python base in both dependency and runtime stages.
[Docker multi-stage contracts](https://docs.docker.com/build/building/multi-stage/) support an
explicit target and artifact copies while the final default target retains existing behavior.

## Reuse decision

Use a thin optional `runtime-python` target in the existing Dockerfile. Copy the existing built
Server production closure and Node binary into the official Python base; do not copy npm/build
workspaces, package tests, local environments or private handoff state. Create UID/GID 1000, keep
read-only rootfs, owned object/model volumes, bounded noexec temporary storage and SIGTERM behavior.
The final `runtime` target remains the existing TypeScript image. A Compose overlay explicitly
selects Python without changing volumes, ports or authority. Switching back changes execution for
future tasks only and must not imply live-run migration or replay.

Keep the development lock intact and derive a runtime-only closure at the same versions. Startup
accepts exactly either approved installed profile via the fixed verifier's `--profile auto`;
Docker build checks `--profile runtime`. Extra, missing or drifted packages still fail. Package
metadata and negative profile tests are owned by the companion Python review in RESEARCH.md.

## Source incorporation

No upstream source copied or substantially adapted; use official built images, documented APIs and
existing OpenBot scripts. Preserve installed distributions' licenses and existing third-party
notices. No new dependency, wire operation, database schema, model privilege or public API.

## Verification plan and limits

- Build checks and Compose parsing for both targets; exact runtime dependency profile with pytest
  and build tools absent. Static contract negatives protect these gates.
- Real container under UID 1000/read-only filesystem: fixed startup preflight, SDK/tool feedback,
  cancellation, Owner login and authenticated API, full PostgreSQL migrations, persistent object
  and disabled model settings across restart, graceful SIGTERM.
- Verify damaged Python installation fails preflight before touching a fresh database; no fallback.
- Reuse existing paired runtime acceptance for unchanged execution/authority behavior. Run targeted
  startup tests and full npm check for changed integration. Extend the existing required native
  amd64/arm64 container CI lane; local emulation and hosted execution must be reported separately.
- No deployment, image publication, live provider, safe crash-resume or OS isolation claim.


## Initial integration evidence

Both production targets built and passed the complete smoke on local Linux arm64 (Docker Desktop
on an ARM Mac): 27 migrations, actual Owner login/API, object/model persistence and graceful stop.
The Python target installed 18 runtime pins, passed pip check and strict profile verification, and
executed the actual SDK/child Unicode tool loop and cancellation without pytest. Missing-interpreter
startup failed before creating the migration schema. No external provider or data was used.

The first smoke attempt exposed a fixture issue: Docker's internal network did not publish a host
port. Keep that network isolated and issue the real HTTP health request from inside the container,
with a 5-second request bound and no host port. Owner API checks already use that path. One default
missing-password probe exceeded its existing 10-second observation window during concurrent work;
the same unchanged negative assertion passed on rerun. No product timeout or security check was
relaxed. Two existing archive/provenance child-process tests also timed out during parallel image
builds; both passed independently once builds ended. A complete rerun was required; its accepted result is below.


## Final acceptance

- WorkBuddy delivered 418 passing Python tests (369 existing + 49 environment-profile cases) on
  macOS. Codex reviewed the changes and independently passed the 49 new cases; only wording of
  the import-inventory test was narrowed to avoid claiming an execution sandbox.
- Codex's full npm run check exited zero after image builds ended: Server 625 passed / 84
  database-environment skips; Web 329; Desktop 359 / 1 skip; Node 51 / 3 skips. Container contracts
  passed 13 cases and fixed startup tests passed six. No timeout threshold was changed.
- Default TypeScript and optional Python images passed local Linux arm64 lifecycle smoke.
  The Python image also passed Linux amd64 smoke under emulation on the ARM host; its disposable
  PostgreSQL container used the host architecture. Both Python builds installed exactly 18 pins,
  and both actual child runs passed Unicode tool feedback, usage and cancellation checks.
- Each lifecycle run applied all 27 migrations, authenticated the Owner, preserved object/model data
  across restart and exited zero on SIGTERM. Missing Python failed before migration creation.
- Existing required CI now builds/tests both targets on native amd64 and arm64 runners; those new
  hosted jobs have not run. No publication, deployment, live provider, existing-volume upgrade,
  checkpoint recovery or independent child sandbox claim is made.
