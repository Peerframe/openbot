# Research: private-engine mutual TLS

- Date: 2026-09-23. Status: implementation qualification, not production acceptance.
- Scope: trusted control/engine clients, never browsers, models or execution sandboxes.
- Existing reuse: Temporal persistence and Linux boundary entries in OPEN_SOURCE_REUSE.md.

## Sources and choice

Reuse Temporal Server1.32.0 / `d94e34a1ebba5410a2e7d07119a76896909591aa` and Python SDK1.33.0 /
`ab52fdde33ee8ed193402625bfdba25d240a762d` (MIT). Read the exact embedded TLS config, local-store
TLS/certificate providers, tls_config_test.go and SDK TLSConfig/client connect source. Existing
samples-server `f811a033a5e79402cab9f792cea132f50344bd17` provides the TLS topology reference;
its MIT notice already exists in deploy/temporal. No server/SDK implementation is copied or forked.

Primary references: [self-hosted security](https://docs.temporal.io/self-hosted-guide/security),
[pinned TLS source](https://github.com/temporalio/temporal/blob/d94e34a1ebba5410a2e7d07119a76896909591aa/common/rpc/encryption/local_store_tls_provider.go),
[pinned tests](https://github.com/temporalio/temporal/blob/d94e34a1ebba5410a2e7d07119a76896909591aa/common/rpc/encryption/tls_config_test.go),
[SDK source](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/temporalio/service.py).
Searched official TLS client-CA/rotation issues and samples. The existing Helm/sample reports show
that internal-worker client TLS configuration matters; do not secure only the public listener.
Certificate/root reload is not equivalent to revoking established connections. This profile uses
an explicit stopped-engine restart and recreated SDK clients for trust rotation, not a hot-reload claim.

Use the released native mTLS path, not a new proxy/cryptographic protocol or custom authorizer.
Require and verify client certificates at frontend and internode listeners, retain hostname/SAN
verification and private loopback ingress. Separate engine-server and control-client CAs. Internode
clients use the engine certificate; frontend trusts the explicit control CA and engine CA for the
internal system worker. Only public roots and the engine leaf/key are mounted into the engine.
CA signing keys and control-client private keys never enter it, workflow inputs/history or artifacts.

This is **authenticated transport for one trusted control group**, not per-namespace/API RBAC.
The existing noop authorizer still permits all engine operations to authenticated group members.
Do not hand that certificate to an untrusted Runtime or public client, expose an engine endpoint
as a product API, or claim mTLS grants Bot/Action authority. Production authorization policy and
control-process credential separation remain explicit integration gates. PostgreSQL stays on its
private same-host bridge; this change does not claim encrypted database connections.

## Implementation and failure gates

An opt-in Compose overlay adds fixed certificate mounts and native TLS environment. Startup rejects
missing files or changed required settings; there is no plaintext fallback. SDK clients read only
explicit bounded PEM paths and pin the server name. Existing plaintext reference remains explicit
and is not upgraded into a production default silently. Product dependencies/configuration stay unchanged.

The acceptance fixture generates disposable short-lived certificates with the platform OpenSSL CLI
(OpenSSL3.6.2 from PATH observed in the Mac fixture; CI records its actual version), using documented req/x509/extension-file
interfaces. [req](https://docs.openssl.org/3.0/man1/openssl-req/),
[x509](https://docs.openssl.org/3.0/man1/openssl-x509/). This is a test issuer, not a production CA
service, dependency or home-made cryptographic implementation. Root/leaf material stays under an
owned temporary0700 directory. Individually mounted engine files can be readable by UID1000 without
exposing their private parent on the host; never mount the CA directory wholesale.

Require actual successful SDK health/namespace operations, reject plaintext/no certificate/wrong
client CA/wrong server name, and prove valid access before and after each rejection. An observation
timeout alone is not rejection evidence. Remove the old control CA during a stopped restart, reject
its old client, then resume the same public approval task with a new client. The eight existing
public-work journeys, cold restore, unknown effect counters and scope-collision checks must still
pass. The reference cert issuance/rotation is not a scalable PKI, SSO, automatic renewal, full secret
recovery, CRL/OCSP or zero-downtime credential revocation claim.

## Recorded local acceptance

The mTLS PostgreSQL fixture passed all eight public-work scenarios, including stopped client-CA
rotation and old-client rejection, engine-only cold restore, database/engine SIGKILL and schema
permission/version gates. Four initial transport rejection cases and the retired-CA case each
had healthy authenticated access before and after. Recovery retained exactly five POST attempts,
one external write and 11 fixture units. Real waiting/completed histories passed offline replay
and a deliberately incompatible definition was rejected without changing product/effect counters.
All 38 reference unit checks passed. A startup regression retains all mounted files but removes
each TLS setting in turn: entry to the upstream service is denied, including absent frontend/server
certificate paths that the upstream provider could otherwise interpret as no TLS. The existing
Linux CI job now runs this mTLS profile; remote CI has not been executed in this local checkpoint.
