import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = `${root}apps/server-python/.venv/bin/python`;
const schema = JSON.parse(
  execFileSync(python, ["-I", "apps/server-python/scripts/export-work-contract.py"], {
    cwd: root,
    encoding: "utf8",
  }),
);
const ast = await openapiTS(schema, { alphabetize: true, defaultNonNullable: false });
const generated =
  "// Generated from Python Work HTTP responses. Run npm run contracts:generate.\n" +
  astToString(ast);
const output = new URL("../../apps/web/src/generated/work-contract.ts", import.meta.url);
// Use the repository's formatter so freshness includes the format actually reviewed in Git.
const formatted = execFileSync(
  `${root}node_modules/.bin/biome`,
  ["format", "--stdin-file-path=work-contract.ts"],
  { cwd: root, input: generated, encoding: "utf8" },
);
if (process.argv.slice(2).length > 1 || process.argv.slice(2).some((arg) => arg !== "--check"))
  throw new Error("Only --check is supported.");
if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf8")) !== formatted)
    throw new Error("Work contract types are stale; run npm run contracts:generate.");
  console.log("Work HTTP generated types match the actual Python route and DTO.");
} else {
  await writeFile(output, formatted);
  console.log("Generated Work HTTP types.");
}
