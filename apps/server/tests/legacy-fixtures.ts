/** Restores only frozen synthetic compatibility bytes inside a test-owned private directory. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import fixture from "./fixtures/legacy-compatibility.json" with { type: "json" };
export { fixture as legacy };
export function restoreLegacyFiles(directory: string, files: Record<string, string>) {
  for (const [relative, encoded] of Object.entries(files)) {
    assert(!relative.startsWith("/") && relative.split("/").every((part) => part !== ".." && part !== "."));
    const path = join(directory, relative);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, Buffer.from(encoded, "base64"), { mode: 0o600, flag: "wx" });
  }
}
