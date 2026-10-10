# C28: retire singleton model configuration

Reviewed on 2026-10-05 against OpenBot `010439bb9002fabb7e1facd8450ee85edbafa309`.
Reuse the C7 Owner preferences decision, the
[Python model services review](python-model-services.md), PostgreSQL 17.10,
OpenAI 3.17.0 / `8c72a700`, and the existing AES-GCM connection cipher. No new dependency,
copied source, provider endpoint, or authority framework.

Targeted searches: `site.postgresql.org docs 17 INSERT ON CONFLICT transaction locks`,
`site.github.com/openai/openai-python audio transcriptions whisper-1`. Reviewed the
[PostgreSQL INSERT contract](https://www.postgresql.org/docs/17/sql-insert.html),
[row/advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html), the
[SDK audio resource](https://github.com/openai/openai-python/blob/8c72a700/src/openai/resources/audio/transcriptions.py)
and [official transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create).
The existing `whisper-1`/JSON request and fixed official OpenAI endpoint remain unchanged.

Compared retaining the old HTTP/file settings, exposing a second temporary credential adapter,
and importing into existing model connections. Choose a one-time trusted startup import. A durable
SQL receipt and connection/audit/default publication commit in one transaction. The receipt survives
connection deletion, preventing restart resurrection. Each original path is hashed into an import
identity; no filesystem paths or credentials enter the receipt or audit. Retain the original file and
key untouched. Import disabled settings as a disabled connection; only timestamped legacy opt-in
may fill an empty C7 default. Never replace an existing default. After the receipt exists, startup
no longer reads or requires the legacy file/key. Empty installations create no singleton key.
A full connection list or invalid unimported ciphertext fails explicitly without discarding data.
The removed file writer remains only as a tested compatibility codec for retained encrypted data.

Owner chooses transcription separately via GET/PUT `/api/v1/settings/transcription` with an
explicit nullable connection ID and the shared Owner-preference revision. General preference edits
preserve this column. Only enabled saved official OpenAI connections qualify. No fallback to a
Bot connection, environment key, default model, custom endpoint or first available connection.
The audio transport checks Owner, selection, connection revision/key and file scope immediately
before sending. Clearing the setting disables transcription; disabling the connection fails closed.
Deletion reports a transcription dependency. Saving preferences never calls a provider.

New Work snapshots capture an explicit Bot model or the C7 default. Existing unselected snapshots
resolve C7 at each model step; a changed default/configuration cannot pass the existing fresh-send
check. Explicit queued selections remain immutable. Historical singleton receipts remain recoverable
without decrypting a key or resending; new steps use connections. The old GET/POST/PUT
`/api/v1/settings/model` and model discovery writer are removed from production composition and Web.
Desktop first-run configuration reuses model services and C7. Existing OS-protected bootstrap keys
are retained; a new bootstrap stores no singleton model key.

Local validation results are recorded with the C28 implementation handoff; paid OpenAI requests,
production migration and installed Desktop qualification are outside this repository change.
