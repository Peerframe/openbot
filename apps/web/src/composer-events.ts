/**
 * Asks the visible channel composer to open its file picker. Dispatched synchronously from a click
 * so the picker keeps the user activation; uploads still go through the composer's checks.
 */
export const composerAttachEvent = "openbot:composer-attach";

/**
 * Asks the open conversation to show one message (C24 查看引用). Detail: `{channelId, messageId}`;
 * a conversation of another channel ignores it.
 */
export const showMessageEvent = "openbot:show-message";
export interface ShowMessageDetail {
  channelId: string;
  messageId: string;
}
