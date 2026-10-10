/** Guards the sole Server boundary, shared SQL pools and retained advisory lock namespaces. */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export function architectureViolations(name: string, source: string): string[] {
  const failures: string[] = [];
  // A conservative source guard, not an authorization parser. Runtime security stays in
  // the tested configuration, request and SQL boundaries; unknown imports remain reviewable.
  const retired = /(?:server-python|python-node-runtime|worker-tunnel|runtime-port|work-python-drain|@fastify\/reply-from)/;
  const paths = [
    ...source.matchAll(/^\s*import\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/gm),
    ...source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g),
  ];
  if (paths.some((match) => retired.test(match[1]!))) failures.push("Retired runtime import");
  if (name !== "database-pool.ts")
    for (const match of source.matchAll(/^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+["']postgres["']/gm)) {
      const identifier = match[1]!.replaceAll("$", "\\$");
      if (new RegExp(`\\b${identifier}\\s*\\(`).test(source)) failures.push("SQL connections must use the shared pool");
    }
  for (const match of source.matchAll(/\b[A-Za-z_$][\w$.]*\s*`([^`]+)`/g)) {
    const query = match[1]!;
    if (/pg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)/.test(query) &&
      !query.includes("LOCK_NAMESPACE.") && !(name === "database-fence.ts" && query.includes("this.namespace")))
      failures.push("Advisory gates must use a named namespace");
  }
  return [...new Set(failures)];
}

export async function checkServerArchitecture(root: string) {
  const source = resolve(root, "apps/server/src"), failures: string[] = [];
  for (const name of (await readdir(source)).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts")))
    for (const message of architectureViolations(name, await readFile(resolve(source, name), "utf8"))) failures.push(`${name}: ${message}`);
  return failures;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const failures = await checkServerArchitecture(fileURLToPath(new URL("../", import.meta.url)));
  if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
}
