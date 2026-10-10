/** Adds the failing scenario step to Vitest's error chain without a second pass/fail counter. */
export async function scenarioStep(name: string, operation: () => Promise<void>) {
  try { await operation(); } catch (cause) { throw new Error(name, { cause }); }
}
