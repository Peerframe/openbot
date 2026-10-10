/** Fixed Python outputs preserve the independent compatibility oracle after runtime retirement. */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
export function frozenWebContracts<T>(section: string): T {
  const bytes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "integration/fixtures/web-contract-compatibility.json"));
  if (createHash("sha256").update(bytes).digest("hex") !== "29160651eed4f3196e990bb62444b352ef98bbe062adc9171afbeaa3ceb4a0ee")
    throw new Error("Frozen Python compatibility evidence changed; verify the pinned source before refreshing.");
  return JSON.parse(bytes.toString("utf8"))[section] as T;
}
