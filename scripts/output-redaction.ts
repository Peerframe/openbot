// Fixture child output is printed for diagnosis only after every owned secret is replaced.
export const FIXTURE_PASSWORD = "[fixture password]";
export const FIXTURE_TOKEN = "[fixture token]";
export const FIXTURE_DATABASE = "[fixture database]";

export type FixtureRedactionLabel =
  | typeof FIXTURE_PASSWORD
  | typeof FIXTURE_TOKEN
  | typeof FIXTURE_DATABASE;
export type FixtureRedaction = readonly [secret: string, label: FixtureRedactionLabel];

/**
 * Replaces every occurrence in the caller's order. An empty or missing secret is a fixture
 * bug: `replaceAll("")` would interleave labels and `String(undefined)` would mask text.
 */
export function redactFixtureOutput(
  output: string,
  redactions: readonly FixtureRedaction[],
): string {
  let redacted = output;
  for (const [secret, label] of redactions) {
    if (typeof secret !== "string" || secret.length === 0)
      throw new Error("Refusing to redact an empty fixture secret.");
    redacted = redacted.replaceAll(secret, label);
  }
  return redacted;
}
