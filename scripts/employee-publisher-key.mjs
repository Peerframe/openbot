import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pathOptions = new Set(["--keyring", "--passphrase-file", "--public-key", "--output"]);
const pathVariables = [
  "OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH",
  "OPENBOT_EMPLOYEE_PUBLISHER_PASSPHRASE_FILE",
];

// npm previously ran the CLI in apps/server. Preserve that path base without depending on
// the old directory/source; only the retained CLI reads or mutates the requested key files.
export function publisherInvocation(arguments_, environment, repositoryRoot = root) {
  const previousBase = join(repositoryRoot, "apps/server");
  const absolute = (value) => (typeof value === "string" ? resolve(previousBase, value) : value);
  const args = [...arguments_];
  for (let index = 1; index < args.length; index++) {
    if (
      pathOptions.has(args[index]) &&
      args[index + 1] !== undefined &&
      !args[index + 1].startsWith("--")
    ) {
      args[index + 1] = absolute(args[index + 1]);
      index++;
    }
  }
  const env = { ...environment };
  for (const name of pathVariables) if (env[name] !== undefined) env[name] = absolute(env[name]);
  return {
    args: [
      "--import",
      "tsx",
      join(repositoryRoot, "packages/employee-publisher/src/employee-publisher-key-cli.ts"),
      ...args,
    ],
    cwd: join(repositoryRoot, "packages/employee-publisher"),
    env,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const invocation = publisherInvocation(process.argv.slice(2), process.env);
  const result = spawnSync(process.execPath, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(
      "Could not start the retained publisher-key CLI. Install the locked developer dependencies first.",
    );
  }
  process.exitCode = result.status ?? 1;
}
