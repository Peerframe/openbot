import {
  AttachmentError,
  type ChannelAttachmentStorage,
  taskAttachmentIds,
} from "./channel-attachments.js";
export type ValidateTaskAttachments = (channelId: string, instruction: string) => Promise<void>;

/** Only original Server-accepted task instructions may create new attachment references. */
export class TaskAttachmentReferences {
  constructor(private readonly storage?: ChannelAttachmentStorage) {}
  async withActive<T>(
    channelId: string,
    instruction: string,
    persist: () => Promise<T>,
  ): Promise<T> {
    const ids = taskAttachmentIds(instruction);
    if (!ids.length) return persist();
    if (!this.storage?.withActiveReferences)
      throw new AttachmentError("Attachment reference validation is unavailable.", 503);
    return this.storage.withActiveReferences(channelId, ids, persist);
  }
  /** The caller starts its DB transaction inside persist, after the storage lock is held. */
  withLock<T>(persist: (validate: ValidateTaskAttachments) => Promise<T>): Promise<T> {
    if (!this.storage?.withReferenceLock)
      return persist(async (_channelId, instruction) => {
        if (taskAttachmentIds(instruction).length)
          throw new AttachmentError("Attachment reference validation is unavailable.", 503);
      });
    return this.storage.withReferenceLock((validate) =>
      persist((channelId, instruction) => validate(channelId, taskAttachmentIds(instruction))),
    );
  }
}
