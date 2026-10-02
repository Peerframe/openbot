/**
 * Asks the visible channel composer to open its file picker. Dispatched synchronously from a click
 * so the picker keeps the user activation; uploads still go through the composer's checks.
 */
export const composerAttachEvent = "openbot:composer-attach";
