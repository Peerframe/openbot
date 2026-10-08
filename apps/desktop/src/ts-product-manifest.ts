/** Fixed package selection, shared by the native stager and compiled Desktop launcher. */
export const TS_CANDIDATE = Object.freeze({
  format: "openbot.desktop.ts-control/v4",
  backend: "ts-control-product",
  readGroup: "transcription",
  writeGroup: "primary-bot",
  authGroup: "owner",
  channelReadGroup: "channels",
  fastifyVersion: "5.12.5",
  replyFromVersion: "12.6.5",
  platform: "darwin",
  arch: "arm64",
});
