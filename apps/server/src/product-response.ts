/** Only server-authored operations construct byte responses, after their Owner transaction commits. */
export class ProductBytes {
  constructor(
    readonly bytes: Buffer,
    readonly headers: Record<string, string>,
  ) {}
}

export class ProductJson {
  constructor(
    readonly value: unknown,
    readonly status: number,
    readonly headers: Record<string, string> = {},
  ) {}
}

/** Encodes the existing RFC 5987 download filename contract, including apostrophes. */
export const attachmentDisposition = (name: string) =>
  "attachment; filename*=UTF-8''" + encodeURIComponent(name).replace(
    /[!'()*]/g, (value) => "%" + value.charCodeAt(0).toString(16).toUpperCase(),
  );
