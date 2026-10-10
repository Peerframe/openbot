/** Actual Squid/kernel qualification in an owned network-none container; never a host installer. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  OwnedDockerFixture,
  allowlistedEnvironment,
} from "../../scripts/acceptance-fixture.ts";
import { compileEgressPolicy } from "./egress-policy.ts";
export function egressArguments(argv: readonly string[]): { image: string; output: string } {
  assert(
    argv.length === 4 &&
      argv[0] === "--fixture-image" &&
      argv[1]?.length === 71 &&
      /^sha256:[a-f0-9]{64}$/.test(argv[1]!) &&
      argv[2] === "--output" &&
      argv[3],
    "Usage: --fixture-image sha256:<local image ID> --output <new directory>",
  );
  return { image: argv[1]!, output: resolve(argv[3]!) };
}
export async function qualifyEgress(argv: readonly string[]) {
  const { image, output: requested } = egressArguments(argv);
  // A fresh output prevents accepting a receipt left by any earlier fixture.
  await mkdir(requested, { mode: 0o700 });
  const output = await realpath(requested),
    source = fileURLToPath(new URL("./", import.meta.url));
  const inputs = await realpath(await mkdtemp(join(tmpdir(), "openbot-egress-input-")));
  const env = allowlistedEnvironment([
    "HOME",
    "PATH",
    "TMPDIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
  ]);
  const docker = new OwnedDockerFixture(source, env),
    name = "openbot-squid-egress-" + randomUUID();
  let result: Record<string, unknown> | undefined;
  try {
    const policy = {
      listen_address: "10.77.0.1",
      listen_port: 3128,
      client_address: "10.77.0.2",
      origins: [
        ...[
          "alpha.example",
          "private.example",
          "metadata.example",
          "control.example",
          "ipv6.example",
          "private6.example",
        ].map((host) => ({ scheme: "http", host, port: 18080 })),
        { scheme: "https", host: "beta.example", port: 18443 },
      ],
      forbidden_networks: ["93.184.216.35/32"],
    };
    await writeFile(join(inputs, "squid.conf"), compileEgressPolicy(policy), { mode: 0o644 });
    await copyFile(join(source, "egress_probe.ts"), join(inputs, "egress_probe.ts"));
    await chmod(join(inputs, "egress_probe.ts"), 0o644);
    await chmod(inputs, 0o755);
    const label = docker.reserveContainer(
      name,
      { key: "openbot.fixture", value: randomUUID() },
      "Squid network-none qualification",
    );
    docker.run(
      [
        "create",
        "--platform=linux/amd64",
        "--pull=never",
        "--name",
        name,
        "--label",
        label,
        "--network=none",
        "--cpus=1",
        "--memory=384m",
        "--memory-swap=384m",
        "--pids-limit=64",
        "--security-opt=no-new-privileges",
        "--cap-add=NET_ADMIN",
        "--restart=no",
        "--sysctl=net.ipv6.conf.all.disable_ipv6=0",
        "--sysctl=net.ipv6.conf.lo.disable_ipv6=0",
        "--env=OPENBOT_EGRESS_FIXTURE=network-none-v1",
        "--mount",
        `type=bind,src=${inputs},dst=/input,readonly`,
        "--mount",
        `type=bind,src=${output},dst=/output`,
        image,
        "node",
        "/input/egress_probe.ts",
      ],
      30000,
    );
    const [inspection] = JSON.parse(docker.run(["inspect", name], 15000));
    assert.equal(inspection.HostConfig.NetworkMode, "none");
    assert.equal(inspection.HostConfig.Privileged, false);
    assert.match(inspection.Id, /^[a-f0-9]{64}$/);
    assert.equal(inspection.Image, image);
    const log = await open(join(output, "RUN.log"), "wx", 0o600);
    let execution: ReturnType<typeof spawnSync>;
    try {
      execution = spawnSync("docker", ["start", "--attach", inspection.Id], {
        env,
        stdio: ["ignore", log.fd, log.fd],
        timeout: 150000,
      });
    } finally {
      await log.close();
    }
    assert(
      !execution.error && execution.signal === null,
      "fixture did not finish within its bound; inspect RUN.log",
    );
    const guest: unknown = JSON.parse(await readFile(join(output, "GUEST_RESULT.json"), "utf8"));
    assert(
      guest &&
        typeof guest === "object" &&
        !Array.isArray(guest) &&
        "accepted" in guest &&
        typeof guest.accepted === "boolean",
      "fixture did not produce a valid result; inspect RUN.log",
    );
    result = {
      ...guest,
      fixtureImage: image,
      containerExitCode: execution.status,
      accepted: guest.accepted && execution.status === 0,
    };
  } finally {
    try {
      docker.cleanup();
    } finally {
      await rm(inputs, { recursive: true, force: true });
    }
  }
  assert(result);
  result.ownedContainerRemoved = true;
  await writeFile(join(output, "RESULT.json"), JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(result));
  assert.equal(result.accepted, true, "Squid/kernel egress qualification failed");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await qualifyEgress(process.argv.slice(2));
