# Employee package signing

[English](EMPLOYEE_SIGNING.md) · [简体中文](EMPLOYEE_SIGNING.zh-CN.md)

OpenBot can sign the existing identity-free `openbot.employee/v1` template with an Owner-controlled
Ed25519 key. The result is a DSSE envelope. A receiving Server accepts that envelope only when its
local trust store already contains the publisher public key.

This feature is experimental. Verification first produces a read-only quarantine preview. An
authenticated Owner may then activate the exact reviewed digest as a fresh local Employee; every
skill remains a disabled candidate. Activation cannot copy memory, bind a Worker Host, or grant
authority.

The offline CLI lives in `packages/employee-publisher`; it neither starts nor imports the old
TypeScript Server or a test oracle. After the repository's normal locked `npm ci`, build its
shared contracts once with `npm exec -- turbo run build --filter=@openbot/employee-publisher`.

The root command still loads the root `.env`. For compatibility, relative publisher flags
(`--keyring`, `--passphrase-file`, `--public-key`, `--output`) and
`OPENBOT_EMPLOYEE_PUBLISHER_*` paths retain their previous `apps/server` base, even when that
directory no longer exists. Prefer absolute paths for a new installation. For example, the
`./data` paths below refer to `<checkout>/apps/server/data`, not `<checkout>/data`.

## Initialize the local publisher

Choose two different protected locations: one for the keyring and one for its passphrase.

```bash
npm run employee:publisher-key -- init \
  --keyring ./data/employee-publisher \
  --passphrase-file ./data/employee-publisher-secret/passphrase
```

If the passphrase file does not exist, the command creates a random one with Owner-only
permissions. It prints the active `ed25519:<sha256-spki>` key id but never prints private key
material. Configure both paths and restart the Server:

```dotenv
OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH=./data/employee-publisher
OPENBOT_EMPLOYEE_PUBLISHER_PASSPHRASE_FILE=./data/employee-publisher-secret/passphrase
```

Those two variables configure the CLI and the legacy Server. The Python product entry point
uses a separate explicit pair; set them to the **same absolute paths** selected above:

```dotenv
OPENBOT_CONTROL_PUBLISHER_DIRECTORY=/absolute/protected/employee-publisher
OPENBOT_CONTROL_PUBLISHER_PASSPHRASE_FILE=/absolute/protected/employee-publisher-secret/passphrase
```

Both Python variables are required together. They are not implicit aliases of the CLI
variables, and Python does not inherit the launcher's historical relative-path base. Restart
the selected Server after key or trust changes. The existing encrypted keyring, public trust
manifest and DSSE format are unchanged. See [relocation research](research/retained-developer-tools.md).

An explicitly configured but unreadable, loosely permissioned, symlinked, malformed, or mismatched
keyring stops Server startup. OpenBot does not silently fall back to unsigned export.

## Share and trust a publisher

The publisher exports only a public key:

```bash
npm run employee:publisher-key -- export-public \
  --output ./openbot-publisher.pub.pem \
  --keyring ./data/employee-publisher \
  --passphrase-file ./data/employee-publisher-secret/passphrase
```

Send the PEM file and its printed key id through different authenticated channels. The receiver
must compare that fingerprint out of band, then explicitly trust it:

```bash
npm run employee:publisher-key -- trust \
  --public-key ./openbot-publisher.pub.pem \
  --expected-key-id ed25519:<verified-sha256-spki-fingerprint> \
  --keyring ./data/employee-publisher \
  --passphrase-file ./data/employee-publisher-secret/passphrase
```

Restart the receiving Server. An Employee file never makes an included key trusted, and the Web API
cannot modify this trust store.

## Rotate and revoke

```bash
npm run employee:publisher-key -- rotate \
  --keyring ./data/employee-publisher \
  --passphrase-file ./data/employee-publisher-secret/passphrase

npm run employee:publisher-key -- revoke \
  --key-id ed25519:<retired-key-fingerprint> \
  --keyring ./data/employee-publisher \
  --passphrase-file ./data/employee-publisher-secret/passphrase
```

Rotation creates a new active signer and retains the previous public key for verification. The
active key cannot be revoked directly; rotate first. Revocation excludes a retired or externally
trusted key from verification. Every mutation requires a Server restart.

## Back up and recover

- Back up the keyring and passphrase separately, encrypted, and off the Server.
- Never put either location inside an Employee package, Git repository, browser-readable folder,
  shared Worker Host volume, or log collector.
- Losing the private key prevents new signed exports. Losing the trust manifest prevents the Server
  from recognizing previously trusted publishers.
- Restoring files does not grant Employee authority; import remains quarantined.

This local trust store does not establish a globally verified human identity, publish revocation to
other users, provide threshold recovery, or protect against a compromised Owner account. Public
distribution will require the planned TUF/Sigstore registry adapter. See
[ADR-0024](decisions/0024-owner-employee-publisher-keys.md) and the
[upstream research](research/employee-publisher-key-lifecycle.md).
