import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("./qualify.mjs", import.meta.url));
const ownedId = "a".repeat(64);

// Exercise the real entrypoint's finally block before any database access. The subprocess
// simulates daemon creation followed by a failed/terminated CLI; no Docker daemon is contacted.
for (const scenario of [
  { mode: "lost-response", removed: true },
  { mode: "terminated", removed: true },
  { mode: "not-created", removed: false },
  { mode: "different-name", removed: false, error: /Refusing unowned S7 container name/ },
  { mode: "different-label", removed: false, error: /Refusing unowned S7 container label/ },
  { mode: "changed-id", removed: false, error: /Refusing changed S7 container identity/ },
  { mode: "invalid-id", removed: false, error: /Refusing invalid S7 container ID/ },
  { mode: "lookup-failure", removed: false, error: /synthetic daemon lookup failure/ },
]) {
  test(`S7 startup cleanup: ${scenario.mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "s7-cleanup-test-"));
    const transcript = join(directory, "commands.json");
    const state = join(directory, "state.json");
    try {
      await writeFile(
        join(directory, "docker"),
        `#!${process.execPath}
const fs = require("node:fs");
const transcript = ${JSON.stringify(transcript)};
const statePath = ${JSON.stringify(state)};
const mode = ${JSON.stringify(scenario.mode)};
const id = ${JSON.stringify(ownedId)};
const args = process.argv.slice(2);
const commands = fs.existsSync(transcript) ? JSON.parse(fs.readFileSync(transcript)) : [];
commands.push(args);
fs.writeFileSync(transcript, JSON.stringify(commands));
if (args[0] === "run") {
  fs.writeFileSync(statePath, JSON.stringify({name: args[args.indexOf("--name") + 1]}));
  if (mode === "terminated") process.kill(process.pid, "SIGTERM");
  process.stderr.write("synthetic run response lost after possible creation\\n");
  process.exit(42);
}
const state = JSON.parse(fs.readFileSync(statePath));
if (args[0] === "container" && args[1] === "ls") {
  if (mode === "lookup-failure") {
    process.stderr.write("synthetic daemon lookup failure\\n");
    process.exit(43);
  }
  if (mode !== "not-created") console.log(mode === "invalid-id" ? "invalid" : id);
} else if (args[0] === "container" && args[1] === "inspect") {
  console.log(JSON.stringify([{
    Id: mode === "changed-id" ? "b".repeat(64) : id,
    Name: mode === "different-name" ? "/another-container" : "/" + state.name,
    Config: {Labels: {"openbot.fixture": mode === "different-label" ? "another-fixture" : "s7"}}
  }]));
} else if (args[0] === "container" && args[1] === "rm") {
  console.log(id);
} else {
  process.stderr.write("Unexpected Docker command\\n");
  process.exit(44);
}
`,
        { mode: 0o700 },
      );
      const result = spawnSync(process.execPath, [entrypoint], {
        env: {
          ...process.env,
          PATH: `${directory}${delimiter}${process.env.PATH}`,
          TMPDIR: directory,
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, "Startup/cleanup failure must remain a failure");
      if (scenario.error) assert.match(result.stderr, scenario.error);
      const commands = JSON.parse(await readFile(transcript, "utf8"));
      const { name } = JSON.parse(await readFile(state, "utf8"));
      assert.match(name, /^openbot-s7-[a-f0-9-]{36}$/);
      assert.equal(commands.filter(([command]) => command === "run").length, 1);
      assert.ok(
        commands.every(
          ([command, subcommand]) =>
            command === "run" ||
            (command === "container" && ["ls", "inspect", "rm"].includes(subcommand)),
        ),
        "No creation retry or unrelated Docker command is allowed",
      );
      assert.deepEqual(commands[1], [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `name=${name}`,
        "--filter",
        "label=openbot.fixture=s7",
        "--format",
        "{{.ID}}",
      ]);
      const removals = commands.filter(
        ([command, subcommand]) => command === "container" && subcommand === "rm",
      );
      assert.deepEqual(removals, scenario.removed ? [["container", "rm", "--force", ownedId]] : []);
      if (scenario.removed) assert.deepEqual(commands[2], ["container", "inspect", ownedId]);
      assert.ok(
        !(await readdir(directory)).some((name) => name.startsWith("openbot-s7-")),
        "The entrypoint must clean its temporary files even after startup/cleanup failure",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
