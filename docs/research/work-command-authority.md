# Work command authority: reuse review before implementation

Date: 2026-09-25. This review downloaded public release source/metadata into this packet, checked archive SHA-256, and read source, licenses, tests, release notes and current issue/security metadata. The preimplementation review did not execute upstream tests or alter keys. Root subsequently accepted the contract and dependency pins; the integrated parsing/signature slice remains incapable of dispatch. PostgreSQL consumption and product execution are still under development.

## Decision

Use released Python joserfc 1.7.5 for Compact JWS and rfc8785 0.1.4 for RFC 8785 canonicalization. Reuse the repository's locked cryptography 50.0.1. Retain jose 6.2.12 for TypeScript Node and the previously reviewed canonicalize 5.0.0 JCS direction. A small strict schema/key/claim adapter surrounds those libraries. No custom JWT/JCS implementation, external codec service, Node subprocess holding Control signing keys, OAuth server or extra identity plane is necessary.

PostgreSQL retains Work authorization and single consumption; crypto does not implement those semantics. The new Work domain deliberately adapts ADR-0045, whose legacy approve/issue and recovery rule cannot be copied unchanged into Work admission/unknown recovery.

## Standards actually rechecked

- [PostgreSQL 17 explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html): conflicting row locks wait until transaction end; consistent lock ordering avoids deadlocks. Apply the existing source-before-Task order, lock credential authority against revoke, use short transactions and refresh reads after waiting. The repository already uses READ COMMITTED, bounded statement/lock/transaction timeouts and trusted transaction primitives.
- [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725): fixed algorithm verification, explicit token typing and mutually exclusive validation rules support separate dispatch/consume/permit/receipt domains. OpenBot must additionally validate exact identity and operational scope.
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785): standardized canonical JSON is the operation fingerprint encoding. Existing Python Work intent digests remain separate; do not relabel them as JCS.
- [RFC 9864](https://www.rfc-editor.org/rfc/rfc9864.pdf) and [joserfc's official implementation guide](https://jose.authlib.org/en/guide/jws/): fully specified Ed25519 avoids the polymorphic EdDSA identifier. The selected pin contains the implementation and tests; no local algorithm alias is needed.

## Released candidates and exact pins

| Candidate | Reviewed pin and license | Evidence and decision |
| --- | --- | --- |
| joserfc | 1.7.5 / commit 357c319119773c021bc8da433bdf31e42f77974b; BSD-3-Clause | Selected. Official release 2026-08-29; Python >=3.10; only ordinary runtime requirement cryptography>=45.0.1. Existing 50.0.1 satisfies it. The draft extras are not selected. Source explicitly implements Ed25519 and rejects wrong key curves. Maintained Authlib project; public open-issue query returned no issues at review time. |
| rfc8785 | 0.1.4 / commit 4d9b161f6054301d98d0566e813d020fb019ee10; Apache-2.0 | Selected. No runtime dependencies, Python >=3.8. Release 2024-09-27 is old, but repository is not archived and has activity through 2026-09-16. The two open entries were maintenance/type-check PRs. Strict integer/Unicode/type behavior and RFC vectors fit this small stable standard. It labels itself Beta; cross-language vectors are therefore mandatory before adoption. |
| PyJWT | 2.15.0 / tag bd03a98b72aa7105b7920b9d0e7818369ac76abe → commit 1d41a6478e1562e68ff667fcd703356acf085f68; MIT | Not selected for this profile. Maintained recent release, but actual algorithms.py registers EdDSA rather than fully specified Ed25519. Official issue/PR 1190/1199 still seeks RFC 9864 support. Do not write a custom algorithm registration or weaken the chosen allowlist when joserfc supports the required standard. |
| TS jose | 6.2.12 / 505a55b8f73536082367b2614cb77e927ba96ec1; MIT | Reuse prior full ADR-0045 review. Current lock already contains this exact version transitively. New direct Provider usage must declare the exact dependency after approval. Official maintained Node support issue confirms Ed25519. |
| TS canonicalize | 5.0.0 / 7d97c70c79c9f52070e6c24c38a92f0dd9b32a57; Apache-2.0 | Reuse ADR-0045's exact prior source/test review. Add direct dependency only in the accepted TS implementation slice, and verify shared vectors against Python rfc8785. |

Primary records: [joserfc release](https://github.com/authlib/joserfc/releases/tag/1.7.5), [joserfc pinned source](https://github.com/authlib/joserfc/tree/357c319119773c021bc8da433bdf31e42f77974b), [rfc8785 release](https://github.com/trailofbits/rfc8785.py/releases/tag/v0.1.4), [rfc8785 pinned source](https://github.com/trailofbits/rfc8785.py/tree/4d9b161f6054301d98d0566e813d020fb019ee10), [PyJWT release](https://github.com/jpadilla/pyjwt/releases/tag/2.15.0), [PyJWT RFC9864 PR](https://github.com/jpadilla/pyjwt/pull/1199), [jose Node algorithm support](https://github.com/panva/jose/issues/262). Public PyPI JSON supplied the package files and hashes; GitHub API tag objects established commits. Web cache missed pinned jose raw paths, so that pin's prior recorded review and installed exact lock are credited; no claim is made that those failed fetches reread the source.

## Actual source/test observations

Read joserfc jws.py, _rfc7515/registry.py and compact.py, _rfc9864/jws_eddsa.py, util.py, pyproject.toml, LICENSE, and tests/jws/test_eddsa.py/test_compact.py plus bounded/critical-header test references. Its JWSRegistry accepts an explicit algorithm collection and checks header/payload/signature size. Ed25519 has a fixed curve check. Tests cover exact Ed25519, wrong curve/key, malformed signature, unsupported algorithms, padded signatures and size limits. These tests were inspected, not run.

The library's registered-header check is broader than this application's three allowed fields, and its ordinary JSON decoder does not establish OpenBot's duplicate-key/shape contract. The thin adapter must enforce strict bounded JSON, exact header {alg,typ,kid}, exact key role and fixed ['Ed25519'] before accepting library-verified payloads. Use a concrete locally pinned key; no dynamic URL/key resolver. Reject detached payload, b64/crit, JWE and JSON JWS formats entirely. Library claim verification does not replace exact Work state checks.

Read rfc8785 README/LICENSE, pyproject, _impl.py and tests. It returns UTF-8 bytes, sorts object keys by UTF-16, rejects non-string keys, invalid Unicode, unsupported types, non-finite floats and out-of-domain integers. OpenBot's narrower operation schema rejects all floats and bounds tree/bytes before serialization. The upstream huge optional float corpus can skip when absent; this review makes no full corpus claim.

## Security notices rechecked

The official [joserfc advisories](https://github.com/authlib/joserfc/security/advisories) were queried via GitHub API. Published recent issues include JSON JWS empty-signature bypass fixed in 1.7.4, array-typed single-string claims fixed in 1.7.3, and padded JWT malleability fixed in 1.7.2. Version 1.7.5 is outside those published affected ranges; only strict Compact JWS is selected. Earlier HMAC, RFC7797 size and error-logging issues reinforce rejecting unsupported modes and sanitizing exceptions. A PBES2 advisory describes older <=1.6.2 JWE code and lists no fixed version; JWE/PBES2 is outside this adapter, not presented as generally certified safe.

This is a current public advisory/source review, not proof of absence of vulnerabilities. Candidate tests must exercise unsupported algorithms/formats, cross-purpose/key-role substitution, wrong issuer/audience/nonce/connection, duplicate/unknown JSON keys, numeric dates, bounds and malformed Unicode. Do not log library exception content or input tokens.

## Hashes and incorporation

- joserfc 1.7.5 sdist SHA-256: d5ff536e658e17664f8c1b1ab60dc4aa62aa973fcef1edd33cc44bda45d6f5ea.
- joserfc wheel SHA-256: add2c2c84e8373b084d526a8b53daba5d7a513a118cd2dcd9fc9f979d0922159.
- rfc8785 0.1.4 sdist SHA-256: e545841329fe0eee4f6a3b44e7034343100c12b4ec566dc06ca9735681deb4da.
- rfc8785 wheel SHA-256: 520d690b448ecf0703691c76e1a34a24ddcd4fc5bc41d589cb7c58ec651bcd48.

Archive bytes and public metadata are retained under review/ in this temporary packet only. No upstream code was copied into an OpenBot module or substantially adapted. Proposed dependency packaging must preserve BSD-3-Clause and Apache-2.0 notices, including rfc8785's attribution to the upstream canonicalization reference implementation. Production lock/pin manifests remain root-owned.

## Next bounded verification

After root accepts the contract/pins, load only the hash-verified released packages in an isolated packet dependency directory/venv using existing cryptography; do not alter root environments. Run strict profile tests and Python↔TS golden vectors with synthetic keys. SQL tests use a new owned fixture and verify existing Work decision/admission/fence/rollback semantics, not fake approval. Protocol/schema tests are insufficient to enable the Provider: actual Node/enforcement/receipt, independent deadline, partition and public product artifact journey remain required.

## Integrated codec slice

Root reviewed both modules and tests before integrating the frozen packet. Python locks add only joserfc1.7.5/rfc8785 0.1.4; exact jose6.2.12/canonicalize5.0.0 are root development dependencies for mandatory cross-language checks. The five interoperability cases no longer skip when paths are absent: ordinary repository npm dependencies are required. The existing disposable PostgreSQL/control gate includes the codec suite. No SQL or Provider activation is included in this slice.

Integrated actual codec verification:105 tests passed, including all five cross-language
cases (four token purposes plus JCS/fingerprint vectors), with no skips. Both existing control
venvs installed only the two hash-verified released wheels; the Worker environment matches all63
locked distributions. This dependency increment postdates the61-package Desktop smoke build,
which must be rebuilt before a current-package claim.
