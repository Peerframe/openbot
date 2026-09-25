# Trusted optional command composition

2026-09-25, before implementation. Reuse OpenBot's Work command identity/fingerprint, transactional,
v2 readiness and protected Host ledger entries and docs/research/work-command-authority.md.
The selected stack remains joserfc1.7.5 (357c319119773c021bc8da433bdf31e42f77974b, BSD-3-Clause),
rfc8785 0.1.4 (4d9b161f6054301d98d0566e813d020fb019ee10, Apache-2.0) and cryptography50.0.1.
No dependency, protocol, authority schema or native executor is added. Existing OpenBot MIT
modules provide profiles, registry, pending inbox, dispatch gates, files and one-shot startup.

The concrete missing piece is a trusted local composition file, not a new execution API.
Reuse strict_json/Strict/parse, CommandRoute, TimingPolicy and Command for all existing contracts.
Reuse work_engine_client.read_owned_file for bounded same-uid regular files and O_NOFOLLOW leaf
opens; require explicit absolute normalized paths and reject static symlink aliases. Deployment
must keep parent directories under its control; this is not a new secure filesystem implementation.
Config and Control private key are private. Enforcement configuration contains only a public pin.
No path resolution through environment, provider metadata or dynamic imports is allowed.

Official primary references rechecked:
- joserfc key guidance: https://jose.authlib.org/en/guide/jwk/
- previously reviewed fixed source: https://github.com/authlib/joserfc/tree/357c319119773c021bc8da433bdf31e42f77974b
- cryptography serialization: https://cryptography.io/en/latest/hazmat/primitives/asymmetric/serialization/

The source review already covers released source/tests/advisories/licenses. This incremental
review reads the exact installed TokenSigner/VerificationPin/TokenVerifier and v2 classes.
Control's public pin is derived through the released cryptography serialization API, so existing
self-authorization verification works and existing TokenVerifier rejects a key reused across
Control and Enforcement roles. There is no new crypto routine or JWK/network key discovery.
Private PEM bytes are never part of a public result, config projection or error message.

Verification will use real generated Ed25519 keys and current parsing/JOSE services. A fake
transaction boundary will exercise the real CommandDispatches.start SQL once, explicitly without
claiming PostgreSQL execution. Constructor and parser do not open a registry or start any service.
Deployment, real Linux enforcement and product activation remain root-owned qualification work.

## Completed boundary checks

The fixed GitHub URL had a web-cache miss during this incremental review. The existing full
source/license/advisory review and exact installed wrappers were reused; no new successful
archive download is claimed. Cryptography documentation describes the released serialization
API; the implementation and tests continue to use locked50.0.1, not a newer documentation build.

A base-Control interpreter probe found that top-level channel imports would load Worker-only
packages even when disabled. Imports for the fixed local inbox/transport/driver implementations
now occur only during explicit construction/attach/start. No module name is selected by config
and no importlib or plugin discovery is used. A fresh subprocess test blocks every Worker-only
import and verifies from_file(None,None), and the real base interpreter independently passed.

68 tests passed with actual Ed25519 keys, strict schema/file checks and production signer/verifier.
The real CommandDispatches.start implementation was exercised through a fake SQL transaction;
no PG readiness or execution claim is inferred. Generated fixture keys are deleted per case.

## Native timing compatibility amendment

Before the narrow follow-up, re-read the current protected_host.py configuration loader and
prepare_authorize branch: both require runtimeMaxMs<=50000 and stopAllowanceMs==5000.
The generic TimingPolicy allows a wider domain. Installation now applies this existing Host
compatibility ceiling after ordinary TimingPolicy parsing/budget checks, before reading keys.
This rejects configurations that cannot reach the already implemented native path; it does not
expand qualification or alter either frozen protocol or Host behavior.
