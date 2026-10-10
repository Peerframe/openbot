/** Public HTTP refusals shared by all Server routes; causes never enter response bodies. */
export class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: { error: string; [key: string]: unknown },
    options?: ErrorOptions,
  ) {
    super("Server request refused.", options);
    this.name = "HttpFailure";
  }
}
export const storageUnavailable = (cause?: unknown) =>
  new HttpFailure(503, { error: "Control-plane storage is unavailable." }, { cause });
