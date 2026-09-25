# Research: explicit fresh product command fixture identity

- Status: bounded candidate; no SSH connection, upload, Docker or remote execution.
- Date: 2026-09-25.
- Acceptance: an operator-selected `product[1-9][0-9]{0,2}` under the fixed
  `/opt/openbot-command-0925` base is used for stage, run, read-only check and unused-stage
  cleanup. The consumed product1 identity is never selected implicitly by the CLI.
- Boundary: name selection is not upload authorization or proof of freshness. Existing
  exclusive stage/run/Action reservations remain the authority for refusing identity reuse.

## Evidence and reuse

Reviewed the OpenSSH/POSIX credential and protected Host entries in `OPEN_SOURCE_REUSE.md`,
`product-command-remote-probe.md`, `product-command-failure-capture.md`, and the current
controller/Host preflight-lock implementation. This extends the existing thin adapter only.
The retained OpenSSH portable review is pinned to `1bf5871aead6d73177d727add15ab0f14c258fdf`;
there are no changes to SSH flags, subprocess lifecycle, key validation, or cleanup authority.

Read official Python 3.12 [pathlib](https://docs.python.org/3.12/library/pathlib.html#pathlib.Path.resolve)
and [re.fullmatch](https://docs.python.org/3.12/library/re.html#re.fullmatch) documentation,
and the exact [CPython v3.12.13 pathlib source](https://github.com/python/cpython/blob/v3.12.13/Lib/pathlib.py).
The installed Worker is CPython 3.12.13 (PSF license; online 3.12 docs now show 3.12.14).
`resolve` follows symlinks; therefore Host validation also compares the invocation pathname
with the resolved script location, rejecting aliases rather than silently switching roots.
ASCII `[0-9]` and fullmatch restrict the whole name; no path normalization can broaden it.
No new package/framework is needed; no upstream source is copied or substantially adapted.

## Decision

Add one validated `fixture_name` to RemoteOptions. Retain its old programmatic constructor
compatibility default, but require `--remote-fixture-name` explicitly in remote CLI mode and
reject that flag without a remote target. A fixed base plus this validated basename generates
all four remote operations. Fixed check/cleanup scripts take only that generated root as an
argv argument; they remain narrow scripts, not a general remote file API.

Host ROOT comes from the actual script location. Only its runtime `imports()` gate checks the
fixed parent, strict name and canonical script pathname, before protected imports or effects;
ordinary module imports remain usable for portable tests. Existing protected directory checks
still validate ownership, permissions and symlinks. Case2 success and all three implementation
pins, native50s/remote150s deadlines, exclusive reservations and evidence/cleanup rules remain.
There is no scanning, incrementing, overwriting old directories, deleting tombstones or retry.
Global peer/socket/bundle constraints continue to permit only the original bounded single peer.

## Verification plan and limitation

Local tests cover valid boundaries1/999, invalid names and injection, stage/run/check/cleanup
root equality, CLI explicitness and unchanged local mode, Host location/alias refusal before
imports, and preserved source pins/deadlines. Existing controller/Host regression suites retain
once-only reservation, private evidence and cleanup uncertainty cases. No SSH or remote execution
is performed. A fresh identity still needs a separately approved exact upload and full product
qualification; this patch does not claim product2 success or Linux support.

## Bounded pre-run diagnosis

The failed fixture's `OSError` may carry a filename or credential-bearing text; `safe_code`
then intentionally reduces it to `fixture_failed`. The same candidate records only a finite
built-in exception category and the last traceback location from exact known fixture/case2
source files. Read the official [traceback/code object fields](https://docs.python.org/3.12/reference/datamodel.html#traceback-objects):
`tb_frame.f_code` and `tb_lineno` identify code without reading frame locals or source lines.
Only a whitelisted basename, bounded Python function identifier and line number are retained;
no full path, input, exception text, chained traceback, locals or PEM is added. Unknown sources
have no location and unknown types fall back to Exception. These fields extend the existing
private error/cleanup records and stderr, including separately caught record/cleanup failures.
Cleanup decisions, independent try blocks, locks and post-reservation behavior do not change.
Tests include real local missing-file/directory OSError failures and secret-bearing metadata.
