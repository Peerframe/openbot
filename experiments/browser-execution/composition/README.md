# Isolated Linux browser product qualification

[English](README.md) · [简体中文](README.zh-CN.md)

This is the retained single-use native fixture for the browser retirement gate, not a production
Host installer. The selected `deadline-a1-comp5` identity is consumed. Never rerun it or extend its
600-second original unit. Source/dependency pins and rejected attempts are recorded in
[the research](../../../docs/research/browser-egress-policy.md).

The actual local Work API, PostgreSQL, mTLS Temporal and retained Node reach a Bun/Chromium service
through an SSH loopback relay. Control/Node credentials stay local. On Linux, a private
Docker29.8.1/runsc unit contains separate browser and Squid networks plus owned synthetic targets;
there is no external route, production Docker access or host firewall change. Only the private
profile tmpfs is writable beyond bounded container temporary storage.

`run.py` checks file hashes, fixed runtime identities, Unix socket lengths, original cgroup lifetime,
container arguments and exact mounts before accepting the product result. It verifies HTTPS
acceptance and wrong-host/unknown-CA refusal, thirteen real socket cases, graceful container
replacement, and revocation of an already-open verified TLS tunnel with no further target hit.
The local journey covers four approvals, one click, a downloaded report, offline replay, human
pause and localStorage/persistent-cookie/IndexedDB continuity. Session cookies must disappear.
Acceptance additionally requires original native expiry, empty cgroup, owned runtime removal and
unchanged production containers/firewall/sysctls. Synthetic model responses are not live inference.

For a separately authorized disposable Linux environment, prepare a fresh reviewed packet and new
short native identity; the fixture deliberately has no automatic remote provisioner. Reuse
`native-network/` and `qualify_egress.py` checks in CI for routine contributions. The local product probe
accepts `--recovery linux-replacement --remote-host-config /absolute/private/relay.json`; its JSON
must explicitly supply `sshTarget`, `computerUrl`, `stateUrl`, `targetUrl` and the synthetic fixture
token. The SSH operation is fixed to this packet's `restart`, not caller-provided shell text.

Generate only new test certificates using `prepare_tls.py --output /new/private/tls` with the
locked cryptography50.0.1 environment. It never saves the CA signing key. Initialize a fresh SQL
NSS database with Linux certutil3.98 and import `ca.pem` using `-t C,,`. The reviewed Ubuntu builder
package is `libnss3-tools_3.98-1build1_arm64.deb`, SHA256
`273a3da5dc5d11dbc4efceb787cbe65e1775a3489c84bb393a672f7df17060b8`; its copyright is preserved in
the private packet. Copy only test `cert9.db`, `key4.db` and `ca.pem` to `nssdb/`.
Do not copy a personal trust store, install a host CA, ignore certificate errors, or reuse expired
test certificates. `browser-entry.mjs` installs this database only in the empty container HOME.

This qualifies disconnected synthetic HTTPS composition. Public Internet access, abrupt profile
loss, profile transfer to another machine, installed Desktop and final source retirement remain
separate claims.
