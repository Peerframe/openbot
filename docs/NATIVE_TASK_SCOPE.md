# Native Task UI contract

[English](NATIVE_TASK_SCOPE.md) · [简体中文](NATIVE_TASK_SCOPE.zh-CN.md)

The Server adapters implement all explicit native scope capabilities. UI and full Temporal
acceptance remain separate integration checks. Fixed owner namespace means the existing single Owner session.
All write requests require the existing session cookie and accepted Origin. No token in bodies.

## Upload and prepare input

`POST /api/v1/task-attachments` with `Content-Type: application/octet-stream`, raw bytes, and
`X-OpenBot-Filename: <percent-encoded safe filename>`. Returns 201:

```json
{"attachment":{"id":"uuid","scopeKind":"owner","ownerId":"owner","name":"evidence.csv","mediaType":"text/plain","sizeBytes":19,"sha256":"hex64","createdAt":"ISO timestamp"}}
```

There is no channelId. Preserve filename/MIME/size/SHA in the displayed resource DTO; the Server
checks actual bytes and never trusts the client MIME. Same retained upload limits: text256KiB,
image5MiB, PDF/other supported input10MiB, at most8 selected inputs and20MiB total per Task.

- `GET /api/v1/task-attachments` -> `{attachments: OwnerAttachment[]}` (includes deletedAt).
- `GET /api/v1/task-attachments/{id}` -> `{attachment: OwnerAttachment}`.
- `GET /api/v1/task-attachments/{id}/content` -> download bytes; deleted assets return404.
- `DELETE /api/v1/task-attachments/{id}` with `{}` -> soft-delete DTO.
- `POST /api/v1/task-attachments/{id}/restore` with `{}` -> restored DTO.
- `POST /api/v1/task-attachments/{id}/process` with the existing `{operation: extract|ocr|transcribe,
  password?: string}` contract -> DTO with processing metadata. Processing must precede Task
  creation if the Task is to consume the derived text. Passwords remain transient; explicit
  transcription uses existing configured model/permission rules.

Existing raw image/PDF model support is reused when no processing result exists. A descriptor
is not a claim that the model has read the binary. Audio/video/office inputs require their
existing explicit processing path. Do not silently request OCR/transcription from the UI.

## Create

`POST /api/v1/tasks` keeps botId/objective/tokenLimit/requestKey and accepts optional scope:

```json
{"botId":"bot-uuid","objective":"Check the supplied evidence","tokenLimit":100000,"requestKey":"unique-owner-request","scope":{"version":1,"attachmentIds":["asset-uuid"],"collaboratorBotIds":["peer-bot-uuid"],"knowledge":true,"plugins":true,"web":true}}
```

All scope keys are required when scope is present. IDs must be valid unique UUIDs; the Server
sorts/canonicalizes them. At most32 collaborator choices, no self, only current none/model
Employees; actual child creation retains four-descendant/two-level/300-second bounds. The UI
must label these choices as the Owner's grant for this Task, not a public catalog entitlement.

Omitting scope preserves model/report/result_review only. Empty lists and false booleans grant
nothing new. The same requestKey with a different scope returns409. An identical retry returns
the original Task even after current attachment deletion or Bot changes; it never recaptures.
No attachment IDs or collaborators may be added through corrections; create a new scoped Task.
No channel is created or implicitly read. Channel attachment IDs cannot be used in this namespace.

The existing 202 WorkSnapshot DTO is unchanged. After creation/reload:

`GET /api/v1/tasks/{taskId}/scope` -> `{scope: null}` for no explicit native scope, otherwise:

```json
{"scope":{"version":1,"attachmentIds":["asset-uuid"],"collaboratorBotIds":[],"knowledge":false,"plugins":false,"web":false,"sha256":"scope-hex64","attachments":[{"id":"asset-uuid","name":"evidence.csv","mediaType":"text/plain","sizeBytes":19,"sha256":"original-hex64","metadataSha256":"metadata-hex64"}]}}
```

The UI displays this immutable submitted scope separately from current Task status and action
approval. It must not advertise grant edits or imply deleting/restoring an asset revives a
cancelled Task. Existing cancel, corrections, exact Action approval and unknown reconciliation
endpoints retain their meanings.

## Capability behavior and authority

- `knowledge:true` enables the same reviewed skill catalog/read and Owner-enabled memories for
  this Employee. Runtime can draft one lesson. Only verified successful Task completion inserts
  a pending proposal; only explicit Owner review can create/enable memory. Hermes Agent remains
  the inspiration for this Employee learning direction.
- `plugins:true` intersects the Task scope with current Owner/Bot plugin grants and exact plugin
  revision. Confirm tools still require the existing durable Action approval. Received MCP
  responses prove an observation, not an independently verified business effect.
- `web:true` enables bounded public HTTPS evidence. Search also requires existing explicit
  host/provider configuration. Existing SSRF, redirect, quota, response and unknown rules remain.
- Nonempty `collaboratorBotIds` enables `list_collaborators`, `start_task`, `delegate_task`, and
  `wait_for_task`. The list contains only live eligible Employees from the captured allowlist.
  A child receives only attachment references explicitly included as `[OpenBot attachment: UUID]`
  in its assignment and present in its parent's scope. It inherits permitted knowledge/plugin/web
  flags and a narrowing collaborator list without itself or ancestors; current plugin grants
  and model connections remain mandatory. Each child has its own bounded Task token allowance,
  equal to its parent's allowance. At most four descendants and two levels are permitted; all
  share the first exact root Work Run claim plus 300 seconds. Retries do not extend this deadline.

Native child tool results use `{sourceKind:"task",taskId,runId,botId,status}` where `runId` is the
actual Work Run. Existing channel results retain their legacy Run identity. A lost acknowledgment
restores only the original committed child; missing SQL stays unknown and never creates anew.
Cancellation/revocation checks include the complete root-to-leaf tree. No synthetic channel,
channel membership, legacy Run or assignment message is created for native collaboration.

Native pending proposal DTOs replace `sourceRunId` with
`source:{kind:"task",taskId,runId}`. The other proposal fields and review request are unchanged.
Existing channel proposals retain `sourceRunId`. Owner-accepted native memory provenance is
`reviewed-work-proposal` with `sourceTaskId`, `sourceWorkRunId`, `proposalId`, and `actor:"owner"`.
Native knowledge receipts use a private v2 target bound to the captured profile/scope digest;
legacy channel v1 receipts retain their exact serialized target fields. Neither private receipts
nor the scope digest grant authority, and neither is accepted from the model.

Default or explicitly empty scopes continue to expose only model/report/result_review. The
Python/SQL/SDK tests establish these adapter boundaries; they do not replace actual UI/Temporal
or Linux qualification. Those integrations must use this same captured scope and fresh gates.
