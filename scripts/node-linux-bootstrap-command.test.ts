import assert from "node:assert/strict";
import test from "node:test";
import {
  executeLinuxBootstrapCommand,
  type LinuxBootstrapCommandAdapters,
  type LinuxBootstrapCommandRequest,
  parseLinuxBootstrapArguments,
  runPrivilegedLinuxBootstrapCli,
} from "./node-linux-bootstrap-command.ts";

type MutableCommandAdapters = {
  -readonly [K in keyof LinuxBootstrapCommandAdapters]: LinuxBootstrapCommandAdapters[K];
};

const archivePath = "/tmp/openbot-node-1.2.3-linux-x64.tar.xz";
const sourceCommit = "b".repeat(40);
const releaseName = `openbot-node-1.2.3-linux-x64-${sourceCommit}`;
const operationIds = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];

test("executes one strict install with derived architecture and generated ids", async () => {
  const seen: Record<string, unknown> = {};
  const adapters = commandAdapters();
  adapters.install = async (request) => {
    Object.assign(seen, request);
    return {
      alreadyInstalled: false,
      releaseName,
      restarted: true,
      rolledBack: false,
      secretDiagnostic: "must-not-escape",
    };
  };

  const result = await executeLinuxBootstrapCommand(
    commandRequest(installArguments(), { GH_TOKEN: "token-value" }),
    adapters,
  );

  assert.deepEqual(result, {
    alreadyInstalled: false,
    ok: true,
    operation: "install",
    releaseName,
    restarted: true,
  });
  assert.deepEqual(seen, {
    architecture: "x64",
    archivePath,
    githubToken: "token-value",
    importId: operationIds[0],
    sourceCommit,
    transactionId: operationIds[1],
    version: "1.2.3",
  });
});

test("executes recovery without accepting install options", async () => {
  const adapters = commandAdapters();
  let recoveryRequest: unknown;
  adapters.recover = async (request) => {
    recoveryRequest = request;
    return {
      outcome: "recovered-previous",
      releaseName,
      restarted: true,
      restoredTarget: "must-not-escape",
    };
  };

  assert.deepEqual(await executeLinuxBootstrapCommand(commandRequest(["recover"]), adapters), {
    ok: true,
    operation: "recover",
    outcome: "recovered-previous",
    releaseName,
    restarted: true,
  });
  assert.deepEqual(recoveryRequest, { recoveryId: operationIds[0] });
  assert.throws(
    () => parseLinuxBootstrapArguments(["recover", "--archive", archivePath]),
    /does not accept install options/,
  );
});

test("rejects unknown, duplicate, missing, excess, and malformed arguments before adapters", async () => {
  let invoked = false;
  const adapters = commandAdapters();
  adapters.install = async () => {
    invoked = true;
  };
  adapters.recover = async () => {
    invoked = true;
  };
  for (const arguments_ of [
    ["unknown"],
    ["install", "--archive", archivePath, "--version", "1.2.3"],
    [...installArguments(), "--version=1.2.4"],
    [...installArguments(), "extra"],
    ["install", "--unknown", "value"],
    [
      "install",
      "--archive",
      "relative.tar.xz",
      "--version",
      "1.2.3",
      "--source-commit",
      sourceCommit,
    ],
    ["recover", "\0"],
    ["recover", "x".repeat(4_097)],
  ]) {
    await assert.rejects(executeLinuxBootstrapCommand(commandRequest(arguments_), adapters));
  }
  assert.equal(invoked, false);
});

test("rejects unsupported runtime and malformed environment credentials before adapters", async () => {
  let invoked = false;
  const adapters = commandAdapters();
  adapters.install = async () => {
    invoked = true;
  };

  await assert.rejects(
    executeLinuxBootstrapCommand(
      {
        ...commandRequest(installArguments()),
        runtime: { architecture: "x64", platform: "darwin" },
      },
      adapters,
    ),
    /supported native Linux architecture/,
  );
  await assert.rejects(
    executeLinuxBootstrapCommand(
      commandRequest(installArguments(), { GH_TOKEN: "bad\ntoken" }),
      adapters,
    ),
    /token is malformed/,
  );
  assert.equal(invoked, false);
});

test("writes only allowlisted success or a generic failure record", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const successful = commandAdapters();
  successful.install = async () => ({
    alreadyInstalled: true,
    releaseName,
    restarted: false,
    rolledBack: false,
    token: "must-not-escape",
  });
  assert.equal(
    await runPrivilegedLinuxBootstrapCli(
      {
        ...commandRequest(installArguments(), { GH_TOKEN: "token-value" }),
        writeError: (value) => errors.push(value),
        writeOutput: (value) => output.push(value),
      },
      successful,
    ),
    0,
  );
  assert.equal(output.length, 1);
  assert.equal(errors.length, 0);
  assert.equal(output[0]?.includes("token-value"), false);
  assert.equal(output[0]?.includes("must-not-escape"), false);

  const failing = commandAdapters();
  failing.install = async () => {
    throw new Error(`secret token-value at ${archivePath}`);
  };
  assert.equal(
    await runPrivilegedLinuxBootstrapCli(
      {
        ...commandRequest(installArguments(), { GH_TOKEN: "token-value" }),
        writeError: (value) => errors.push(value),
        writeOutput: (value) => output.push(value),
      },
      failing,
    ),
    1,
  );
  assert.equal(errors[0], '{"error":"bootstrap-failed","ok":false}\n');
});

function commandRequest(
  arguments_: readonly string[],
  environment: Record<string, unknown> = {},
): LinuxBootstrapCommandRequest {
  return {
    arguments: arguments_,
    environment,
    runtime: { architecture: "x64", platform: "linux" },
  };
}

function installArguments() {
  return [
    "install",
    "--archive",
    archivePath,
    "--version",
    "1.2.3",
    "--source-commit",
    sourceCommit,
  ];
}

function commandAdapters(): MutableCommandAdapters {
  let idIndex = 0;
  return {
    generateId: () => operationIds[idIndex++],
    install: async () => {
      throw new Error("Unexpected install.");
    },
    recover: async () => {
      throw new Error("Unexpected recovery.");
    },
  };
}
