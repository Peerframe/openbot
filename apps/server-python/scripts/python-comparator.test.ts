import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type ComparatorOutputLimit,
  comparatorPaths,
  ONE_MIB,
  type PythonComparatorRun,
  pythonComparatorArguments,
  runPythonComparator,
  spawnErrorCode,
  TEN_SECONDS,
  THIRTY_SECONDS,
  TWO_MIB,
} from "./python-comparator.ts";

// A real child standing in for `.venv/bin/python`. It reports exactly what it received, or performs
// one refusal selected by the program text after `-c`.
const FAKE_INTERPRETER = `#!/bin/sh
program=
previous=
for argument in "$@"; do
  if [ "$previous" = "-c" ]; then program=$argument; fi
  previous=$argument
done
case "$program" in
  sleep) exec sleep 60 ;;
  flood) head -c ${ONE_MIB + 1} /dev/zero; exit 0 ;;
  flood-hold) head -c ${ONE_MIB + 1} /dev/zero; exec sleep 60 ;;
  fail) printf 'refused\\n' >&2; exit 3 ;;
esac
printf 'argc=%s\\n' "$#"
for argument in "$@"; do printf 'arg=%s\\n' "$argument"; done
printf 'cwd=%s\\n' "$(pwd -P)"
printf 'path=%s\\n' "$PATH"
printf 'probe=%s\\n' "\${OPENBOT_COMPARATOR_PROBE-unset}"
printf 'stdin=%s\\n' "$(cat)"
`;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

async function fakePackage(t: TestContext, withInterpreter: boolean): Promise<URL> {
  const directory = await mkdtemp(join(tmpdir(), "openbot-python-comparator-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "src"));
  if (withInterpreter) {
    const bin = join(directory, ".venv", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "python"), FAKE_INTERPRETER);
    await chmod(join(bin, "python"), 0o755);
  }
  return pathToFileURL(`${directory}/`);
}

function reported(stdout: string): { argv: string[]; fields: Map<string, string> } {
  const argv: string[] = [];
  const fields = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === "arg") argv.push(value);
    else fields.set(key, value);
  }
  return { argv, fields };
}

test("an unbuffered caller gets -I -u, its arguments, cwd and stdin, and only PATH", async (t) => {
  const packageRoot = await fakePackage(t, true);
  process.env.OPENBOT_COMPARATOR_PROBE = "ambient-secret";
  t.after(() => {
    Reflect.deleteProperty(process.env, "OPENBOT_COMPARATOR_PROBE");
  });
  const run: PythonComparatorRun = {
    packageRoot,
    program: "report",
    unbuffered: true,
    programArguments: ["/fixtures/a.json", "/fixtures/b.json"],
    cwd: packageRoot,
    stdin: '[{"kind":"steer"}]',
    timeoutMs: THIRTY_SECONDS,
    maxBufferBytes: TWO_MIB,
  };
  const child = runPythonComparator(run);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const { argv, fields } = reported(child.stdout);
  const source = fileURLToPath(new URL("src", packageRoot));
  assert.deepEqual(argv, [
    "-I",
    "-u",
    "-c",
    "report",
    source,
    "/fixtures/a.json",
    "/fixtures/b.json",
  ]);
  assert.deepEqual(argv, pythonComparatorArguments(run));
  assert.equal(fields.get("argc"), "7");
  assert.equal(fields.get("cwd"), await realpath(fileURLToPath(packageRoot)));
  assert.equal(fields.get("path"), "/usr/bin:/bin");
  assert.equal(fields.get("probe"), "unset");
  assert.equal(fields.get("stdin"), '[{"kind":"steer"}]');
});

test("a buffered caller without cwd or stdin gets no -u, the inherited cwd and empty stdin", async (t) => {
  const packageRoot = await fakePackage(t, true);
  const child = runPythonComparator({
    packageRoot,
    program: "report",
    unbuffered: false,
    timeoutMs: TEN_SECONDS,
    maxBufferBytes: ONE_MIB,
  });
  assert.equal(child.status, 0, child.stderr);
  const { argv, fields } = reported(child.stdout);
  assert.deepEqual(argv, ["-I", "-c", "report", fileURLToPath(new URL("src", packageRoot))]);
  assert.equal(fields.get("cwd"), await realpath(process.cwd()));
  assert.equal(fields.get("probe"), "unset");
  assert.equal(fields.get("stdin"), "");
});

test("a nonzero child exit is returned with its exact stderr, not thrown", async (t) => {
  const child = runPythonComparator({
    packageRoot: await fakePackage(t, true),
    program: "fail",
    unbuffered: true,
    timeoutMs: THIRTY_SECONDS,
    maxBufferBytes: TWO_MIB,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 3);
  assert.equal(child.stderr, "refused\n");
  assert.equal(child.stdout, "");
});

test("a missing package interpreter surfaces as ENOENT for the caller's diagnostic", async (t) => {
  const packageRoot = await fakePackage(t, false);
  const child = runPythonComparator({
    packageRoot,
    program: "report",
    unbuffered: true,
    timeoutMs: THIRTY_SECONDS,
    maxBufferBytes: TWO_MIB,
  });
  assert.equal(spawnErrorCode(child.error), "ENOENT");
  assert.equal(child.status, null);
  assert.equal(spawnErrorCode(undefined), undefined);
  assert.equal(
    comparatorPaths(packageRoot).interpreter.href,
    new URL(".venv/bin/python", packageRoot).href,
  );
});

test("output beyond the caller's bound is refused and the larger bound admits it", async (t) => {
  const packageRoot = await fakePackage(t, true);
  const flood = (maxBufferBytes: ComparatorOutputLimit, program = "flood") =>
    runPythonComparator({
      packageRoot,
      program,
      unbuffered: false,
      timeoutMs: TEN_SECONDS,
      maxBufferBytes,
    });
  // Node v22.22.2 src/spawn_sync.cc records pipe errors independently of the process exit.
  // Keep this child alive to test termination; a fast exit may legitimately retain status 0
  // alongside ENOBUFS. The separate fast-exit case below still requires overflow refusal.
  const refused = flood(ONE_MIB, "flood-hold");
  assert.equal(spawnErrorCode(refused.error), "ENOBUFS");
  assert.notEqual(refused.status, 0);
  assert.equal(refused.signal, "SIGTERM");
  const fastExit = flood(ONE_MIB);
  assert.equal(spawnErrorCode(fastExit.error), "ENOBUFS");
  const admitted = flood(TWO_MIB);
  assert.equal(admitted.error, undefined);
  assert.equal(admitted.status, 0);
  assert.equal(admitted.stdout.length, ONE_MIB + 1);
});

test("a child past its deadline is killed and reported as ETIMEDOUT", {
  timeout: 30_000,
}, async (t) => {
  const child = runPythonComparator({
    packageRoot: await fakePackage(t, true),
    program: "sleep",
    unbuffered: false,
    timeoutMs: TEN_SECONDS,
    maxBufferBytes: ONE_MIB,
  });
  assert.equal(spawnErrorCode(child.error), "ETIMEDOUT");
  assert.equal(child.signal, "SIGTERM");
});

test("an untyped caller cannot choose another deadline or output bound", async (t) => {
  const run = {
    packageRoot: await fakePackage(t, true),
    program: "report",
    unbuffered: false,
    timeoutMs: TEN_SECONDS,
    maxBufferBytes: ONE_MIB,
  };
  assert.throws(
    () => {
      Reflect.apply(runPythonComparator, undefined, [{ ...run, timeoutMs: 5_000 }]);
    },
    { name: "TypeError", message: "Comparator timeout must be 10 or 30 seconds." },
  );
  assert.throws(
    () => {
      Reflect.apply(runPythonComparator, undefined, [{ ...run, maxBufferBytes: 4_096 }]);
    },
    { name: "TypeError", message: "Comparator output limit must be 1 or 2 MiB." },
  );
});

test("the identity comparator's fixtures keep unique ids and known schemas", () => {
  // The Python results are keyed by id, so a duplicate id would hide a case from the comparison.
  const ids = new Set<string>();
  for (const name of [
    "identity-inputs.json",
    "quick-bot-inputs.json",
    "profile-inputs.json",
    "task-inputs.json",
  ]) {
    const path = new URL(`../tests/fixtures/${name}`, import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const cases = isRecord(parsed) ? parsed.cases : undefined;
    if (!isList(cases)) assert.fail(`${name} has no case list`);
    assert.ok(cases.length > 0, `${name} has no cases`);
    for (const entry of cases) {
      if (!isRecord(entry)) assert.fail(`${name} has a malformed case`);
      const { id, schema } = entry;
      if (typeof id !== "string") assert.fail(`${name} has a case without an id`);
      assert.ok(
        schema === "quickBot" ||
          schema === "bot" ||
          schema === "channel" ||
          schema === "profile" ||
          schema === "task",
        `${id} names an unknown schema`,
      );
      assert.ok(!ids.has(id), `${id} is duplicated`);
      ids.add(id);
    }
  }
});
