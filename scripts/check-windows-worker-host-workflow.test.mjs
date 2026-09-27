import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse, stringify } from "yaml";
import { validateWindowsWorkerHostBuildLane } from "./check-windows-worker-host-workflow.mjs";

const fixture = Object.fromEntries(
  await Promise.all(
    Object.entries({
      workflow: new URL("../.github/workflows/ci.yml", import.meta.url),
      globalJson: new URL("../apps/worker-host-windows/global.json", import.meta.url),
      buildProps: new URL("../apps/worker-host-windows/Directory.Build.props", import.meta.url),
      hostProject: new URL(
        "../apps/worker-host-windows/OpenBot.WorkerHost.Windows/OpenBot.WorkerHost.Windows.csproj",
        import.meta.url,
      ),
      artifactChecker: new URL("./check-windows-worker-host-artifact.ps1", import.meta.url),
    }).map(async ([name, url]) => [name, await readFile(url, "utf8")]),
  ),
);

test("accepts the locked build-only Windows Worker Host lane", () => {
  assert.doesNotThrow(() => validateWindowsWorkerHostBuildLane(fixture));
});

test("rejects moving SDK action pins, runners, caches, and uploads", () => {
  for (const changed of [
    fixture.workflow.replaceAll(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/checkout@v7",
    ),
    fixture.workflow.replace(
      "actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68",
      "actions/setup-dotnet@v6",
    ),
    fixture.workflow.replace("runs-on: windows-2025", "runs-on: windows-latest"),
    fixture.workflow.replace("working-directory: apps/worker-host-windows", "working-directory: ."),
    fixture.workflow.replace(
      "          global-json-file: apps/worker-host-windows/global.json",
      "          global-json-file: apps/worker-host-windows/global.json\n          cache: true",
    ),
    fixture.workflow.replace(
      "      - name: Inspect bounded publish inventory",
      "      - uses: actions/upload-artifact@v4\n      - name: Inspect bounded publish inventory",
    ),
  ]) {
    assert.throws(
      () => validateWindowsWorkerHostBuildLane({ ...fixture, workflow: changed }),
      /missing required fragment|broadens/,
    );
  }
});

test("rejects unlocked restore and reordered validation", () => {
  assert.throws(
    () =>
      validateWindowsWorkerHostBuildLane({
        ...fixture,
        workflow: fixture.workflow.replace(" --locked-mode", ""),
      }),
    /missing required fragment/,
  );
  const changed = fixture.workflow.replace(
    "      - name: Run host contract tests",
    "      - name: Inspect bounded publish inventory\n        shell: pwsh\n        run: ../../scripts/check-windows-worker-host-artifact.ps1 -PublishDirectory fake\n      - name: Run host contract tests",
  );
  assert.throws(
    () => validateWindowsWorkerHostBuildLane({ ...fixture, workflow: changed }),
    /must restore, build, test, publish, then inspect/,
  );
});

test("rejects SDK, package, or artifact-boundary drift", () => {
  assert.throws(
    () =>
      validateWindowsWorkerHostBuildLane({
        ...fixture,
        globalJson: fixture.globalJson.replace("10.0.400", "10.0.401"),
      }),
    /global.json/,
  );
  assert.throws(
    () =>
      validateWindowsWorkerHostBuildLane({
        ...fixture,
        hostProject: fixture.hostProject.replace("[4.0.0]", "4.*"),
      }),
    /project is missing/,
  );
  assert.throws(
    () =>
      validateWindowsWorkerHostBuildLane({
        ...fixture,
        artifactChecker: fixture.artifactChecker.replace("128MB", "512MB"),
      }),
    /artifact checker is missing/,
  );
});

test("accepts peer reordering, step renaming and YAML formatting", () => {
  const value = parse(fixture.workflow);
  value.jobs = Object.fromEntries(Object.entries(value.jobs).reverse());
  for (const step of value.jobs["windows-worker-host"].steps)
    if (step.name) step.name = "Describe a checked property";
  assert.doesNotThrow(() =>
    validateWindowsWorkerHostBuildLane({ ...fixture, workflow: stringify(value, { indent: 4 }) }),
  );
});
