/** Runs the existing named HTTP/HTTPS gates against the complete Server Vitest consumers. */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DevProcessOwner } from "./dev-processes.ts";
import { allowlistedEnvironment } from "./acceptance-fixture.ts";
import { issueTlsFixture } from "./tls-fixture.ts";

export async function runContractSuites(tls: boolean, args: readonly string[]) {
assert(
  args.length === 0 ||
    (args.length === 2 && args[0] === "--suite" && ["all", "models", "publisher"].includes(args[1] ?? "")),
  "Use contracts:http:ts or contracts:http:tls [--suite NAME].",
);
const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-contract-tls-")));
const owner = new DevProcessOwner({
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  graceMs: 30_000,
});
const stop = () => void owner.stop();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const fixture = tls ? await issueTlsFixture(directory) : undefined;
  // Node loads this one disposable trust anchor at process startup. OS trust is unchanged.
  const child = owner.start(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "--config", "scripts/vitest.integration.config.ts", "scripts/http-contracts.integration.test.ts", ...(args[1] ? ["-t", args[1]] : [])],
    {
      ...allowlistedEnvironment([
        "PATH",
        "HOME",
        "TMPDIR",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_CONFIG",
      ]),
      ...(fixture ? { NODE_EXTRA_CA_CERTS: fixture.caPath, OPENBOT_CONTRACT_TLS_DIRECTORY: directory } : {}),
    },
  );
  const deadline = setTimeout(() => child.kill("SIGTERM"), 600_000);
  try {
    await owner.waitSuccess(child);
  } finally {
    clearTimeout(deadline);
  }
} finally {
  await owner.stop();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await rm(directory, { recursive: true, force: true });
}
}
