/** Fixed package selection, shared by the native stager and compiled Desktop launcher. */
export const TS_CANDIDATE = Object.freeze({
  format: "openbot.desktop.ts-control/v7",
  backend: "ts-control-product",
  readGroup: "transcription",
  writeGroup: "primary-bot",
  authGroup: "owner",
  productGroup: "p3",
  channelReadGroup: "channels",
  fastifyVersion: "5.12.5",
  replyFromVersion: "12.6.5",
  koffiVersion: "3.3.2",
  openaiVersion: "7.28.0",
  anthropicVersion: "0.131.0",
  platform: "darwin",
  arch: "arm64",
});
