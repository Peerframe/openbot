import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import path from "node:path";
import { nodeMessageSchema, protocolVersion } from "@openbot/protocol";
import { parseCandidateSmokeArguments, runPackagedNodeSmoke } from "./node-linux-candidate.ts";
import { verifyCandidateDirectory } from "./node-linux-release.ts";

if (process.platform !== "linux") {
  throw new Error("Packaged Linux runtime smoke tests can only run on Linux.");
}

const options = parseCandidateSmokeArguments(process.argv.slice(2));
if (process.arch !== options.architecture) {
  throw new Error("Packaged Linux runtime smoke test requires a matching host architecture.");
}
const candidate = path.resolve(options.candidate);
const manifest = await verifyCandidateDirectory(candidate);
if (manifest.architecture !== options.architecture) {
  throw new Error("Release candidate architecture does not match the smoke-test host.");
}

const executable = path.join(candidate, "bin/node");
const entryPoint = path.join(candidate, "app/index.js");
for (const filePath of [executable, entryPoint]) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Packaged runtime entry files must be regular files.");
  }
}
await access(executable, constants.X_OK);

await runPackagedNodeSmoke({
  architecture: options.architecture,
  executable,
  entryPoint,
  helloSchema: nodeMessageSchema,
  protocolVersion,
});
process.stdout.write(
  `${JSON.stringify({ architecture: options.architecture, candidate, handshake: "passed" }, null, 2)}\n`,
);
