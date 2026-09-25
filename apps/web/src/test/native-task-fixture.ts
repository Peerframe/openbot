import type { NativeTaskScope, OwnerAttachment } from "../native-task-api";
export const nativeIds = {
  file: "10000000-0000-4000-8000-000000000001",
  peer: "10000000-0000-4000-8000-000000000002",
  self: "10000000-0000-4000-8000-000000000003",
};
export function ownerFile(change: Partial<OwnerAttachment> = {}): OwnerAttachment {
  return {
    id: nativeIds.file,
    scopeKind: "owner",
    ownerId: "owner",
    name: "evidence.txt",
    mediaType: "text/plain",
    sizeBytes: 19,
    sha256: "a".repeat(64),
    createdAt: "2026-09-25T00:00:00Z",
    ...change,
  };
}
export function nativeScope(change: Partial<NativeTaskScope> = {}): NativeTaskScope {
  const { id, name, mediaType, sizeBytes, sha256 } = ownerFile();
  return {
    version: 1,
    attachmentIds: [id],
    collaboratorBotIds: [],
    knowledge: false,
    plugins: false,
    web: false,
    sha256: "b".repeat(64),
    attachments: [{ id, name, mediaType, sizeBytes, sha256, metadataSha256: "c".repeat(64) }],
    ...change,
  };
}
