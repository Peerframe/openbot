# Research: persistent Owner password and active sessions

- Status: Accepted for C2 implementation; verification evidence belongs to the PR.
- Date: 2026-10-01
- Trigger: credential persistence and authentication/session security boundary.
- Existing pins: CPython 3.12.13, Psycopg 3.3.6, PostgreSQL 17.11, Pydantic 2.13.5;
  [previous Owner-auth review](python-owner-auth.md).

Reviewed [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html),
[session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
[authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html),
[CPython v3.12.13 source](https://github.com/python/cpython/tree/v3.12.13),
[hashlib API](https://docs.python.org/3.12/library/hashlib.html#hashlib.scrypt), and the
[OpenSSL FIPS issue](https://github.com/python/cpython/issues/128071).

| Candidate | Pin / maintenance / license | Fit and decision |
| --- | --- | --- |
| Stdlib scrypt | CPython 3.12.13; upstream hashlib vectors; PSF | Selected: fixed OWASP N=32768,r=8,p=3, 16-byte salt; no new runtime closure |
| Existing SHA-256 environment comparison | Existing OpenBot auth; MIT | Retain for bootstrap only; unsuitable for persisted password hashes |
| Argon2id adapter | OWASP preferred algorithm; extra native/runtime dependency not currently installed | No need to expand packaged Python closure for this bounded feature; reconsider with shared credential needs |
| Delegated identity service | Existing singleton Owner has no OAuth/OIDC authority | Would replace session/policy boundary and require an external service; not selected |

New hashes never store the password. Fixed parameters prevent hostile stored values selecting KDF
costs; two per-service KDF slots bound concurrent work. KDF/OpenSSL errors fail closed. FIPS behavior
is unqualified. User-Agent is only a bounded hint, never authority or proof of a device.

The environment remains bootstrap input, while a singleton SQL row overrides it after rotation.
A revision and shared advisory lock serialize login issuance, rotation and security-session mutations.
Current-password validation is required; existing shared PostgreSQL login throttles also count failed
password-change attempts. Rotation audits and revokes all sessions atomically; self-revocation is
intentional only after a final check of the locked initiating session. Audit/storage failure rolls back.
No default reset-to-environment behavior. Empty-history and previous-history migration, restart,
stale proof, origin, revocation, input bounds and audit rollback are acceptance cases.

No upstream source copied or substantially adapted. OpenBot-specific SQL/HTTP adapters extend the
retained singleton Owner authority; no model/Worker/renderer receives credential or session authority.
