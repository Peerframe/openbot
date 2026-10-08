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
