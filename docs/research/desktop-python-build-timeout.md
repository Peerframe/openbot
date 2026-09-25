# Research: bounded Desktop Python dependency installation

- Status: candidate repair, pending full build validation by the integrating owner
- Date: 2026-09-25
- Acceptance journey: a Python candidate build identifies the failed subprocess stage,
  exit code/signal and outer deadline; slow public wheel downloads have a finite budget
  appropriate for the existing 61-distribution lock.
- Security boundary: build-only subprocesses, fixed official index and exact existing
  requirements; no host venv, user profile, proxy, interpreter override or release change.

## Evidence and reviewed reuse

The existing ledger entry at `docs/OPEN_SOURCE_REUSE.md` (Python product package) points
to `desktop-python-product.md`. Reuse its exact standalone CPython 3.12.13+20260807
archive and Node pins; do not download another interpreter or add a package manager.
The failed staged interpreter reports CPython 3.12.13 and bundled pip 26.2.1; pip is its
only installed distribution. The source lock still contains 61 pinned distributions.

The supplied build log contains repeated PyPI/files.pythonhosted.org 15-second socket
timeouts while pip is gathering wheel metadata, then only the generic child close error.
The staged lock mtime is 05:37:16 UTC and final log mtime 05:42:18 UTC. The existing
pip stage has a 300,000 ms SIGKILL watchdog. These facts strongly identify exhaustion
of the outer install budget after network stalls; the original code discarded signal
and timeout state, so an exact historical signal cannot be recovered from this log.
No wheel installation completion, environment verifier or pip check is reached.
The marker is absent as intended. Signing is not part of this prepare stage.

Searches on 2026-09-25: `site.github.com/pypa/pip resume-retries timeout cmdoptions.py
26.2.1`; `site.nodejs.org child_process close signal event SIGKILL`. Reviewed primary
sources, including installed immutable archive contents:

- [pip 26.2.1 release](https://github.com/pypa/pip/releases/tag/26.2.1)
- [pip 26.2.1 options source](https://github.com/pypa/pip/blob/26.2.1/src/pip/_internal/cli/cmdoptions.py)
  and its installed copy: socket timeout defaults to 15 seconds, connection and resume
  retry limits both default to 5.
- [pip CLI documentation](https://pip.pypa.io/en/stable/cli/pip/): use the maintained
  `--timeout`, `--retries`, `--resume-retries` options instead of a second download loop.
- [Node 22.23.2 child_process](https://nodejs.org/download/release/v22.23.2/docs/api/child_process.html):
  `close` carries code and signal; `error` covers spawn failure; a successful signal
  send alone does not prove exit. Await close after the existing SIGKILL timeout.
- Existing OpenBot Electron downloader performs bounded public download retries; it
  is not reused for Python wheels because pip already owns resolution and retrying.
- The exact pip functional test URL was unavailable to the browser during review;
  this change does not fork pip. The official source/docs plus local subprocess tests
  below cover the narrow integration. Node issue #65646 concerns IPC disconnect and
  does not apply to these `stdio: inherit` children.

## Decision and alternatives

Reuse bundled pip 26.2.1 (MIT) and Node child_process (MIT), with a thin existing script
change. The pip stage receives a fixed 15-minute total budget, explicit 30-second socket
timeout, and the same 5 connection/5 resume retries. No whole install/build replay is
added. All other stages retain 60 seconds. Stage errors report safe fixed names, elapsed
milliseconds, timeout status, code and signal without echoing command arguments or paths.

The larger finite budget addresses the observed build cutoff; it cannot guarantee public
PyPI availability. A persistent wheel cache, mirror, offline wheelhouse or host-venv copy
would introduce another source/provenance/lifecycle boundary and is outside this repair.
The selection marker remains last, after environment and dependency verification.

No third-party source is copied or substantially adapted. Existing OpenBot MIT code is
locally amended; existing notices and distribution hashes remain unchanged.

## Validation boundary

Run original runtime tests plus real local child success, nonzero exit, external signal,
spawn failure and deadline kill tests. Check fixed pip arguments without network and use
the staged pip's parser to confirm the reviewed flags are accepted. Run formatting/lint
and patch applicability. No full prepare, package, download, app, Keychain or user profile
operation is part of this investigation. Full `npm run check` and a new candidate build
remain the integrating owner's responsibility.
