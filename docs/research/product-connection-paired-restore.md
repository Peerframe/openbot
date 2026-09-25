# Nonempty model connection paired restoration

2026-09-25. This extends the completed, stopped product restore qualification with existing
model-connection persistence. No product behavior, dependency, protocol or cryptography changes.
Reuse the accepted [Python service review](python-model-services.md), the S6
[ciphertext/key/AAD preservation requirement](s6-compatibility.md), and the pinned PostgreSQL
17.11 [native restore review](s7-migration-qualification.md). PyCA cryptography remains 50.0.1
at `ffde75a2b594822c740a2e4748b56c00548302bf`; PostgreSQL remains `REL_17_11` and its already
pinned image. No upstream source is copied or adapted by this probe.

Inspected the current `ModelConnectionsService.from_key_path/create/snapshot/resolve`,
`PostgresIdentityStore.create_bot`, `ModelCredentialCipher.load/decrypt` and their existing
tests. Creation and resolution require a valid Owner token but perform no provider network
request. An existing encrypted connection makes missing key creation forbidden. The raw
32-byte, 0600 key and immutable connection ID/preset/endpoint AAD must stay paired with SQL.
Wrong key bytes can be loaded structurally but must fail authenticated decryption at resolve.

After the actual product API/Worker stops, create one enabled synthetic saved connection and
one independent Bot with explicit `model` profile and selection through those public services.
Do not alter the completed media Task's Bot/source. Include connection ciphertext, profile,
selection and audits in the existing full-table row hash, and its real key in paired file hashes.
After native restoration, call the real readers and resolve the restored Bot selection with
the retained connection revision, comparing original secret/provenance only in memory. Missing
and wrong key copies must refuse with `model_credential_unavailable`; missing key must remain
absent. The fixture calls no discovery, connection test, SDK model port or provider network.
It has a deny-all injected provider transport and uses an explicitly allowed `.invalid`
synthetic HTTPS endpoint as defense in depth.

Only stopped completed product restoration is covered. No active Temporal database pairing,
live-provider validity, Desktop OS keychain, roles/ACLs or cross-version migration is claimed.
Generated secrets and private dumps remain local; public evidence includes only booleans,
counts, source hashes and finite rejection codes. Cleanup records exact fixture connection/Bot
identities and removes their audit rows without touching any baseline record.
