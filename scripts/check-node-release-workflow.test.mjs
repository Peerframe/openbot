import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse, stringify } from "yaml";
import { validateNodeReleaseWorkflow } from "./check-node-release-workflow.mjs";

const workflow = await readFile(
  new URL("../.github/workflows/node-linux-release.yml", import.meta.url),
  "utf8",
);

test("accepts the tag-only reproducible attestation workflow", () => {
  assert.doesNotThrow(() => validateNodeReleaseWorkflow(workflow));
});

test("rejects widened triggers or publication authority", () => {
  assert.throws(
    () =>
      validateNodeReleaseWorkflow(workflow.replace("  push:\n", "  workflow_dispatch:\n  push:\n")),
    /broadens/,
  );
  assert.throws(
    () => validateNodeReleaseWorkflow(workflow.replace("contents: read", "contents: write")),
    /missing|required|broadens/,
  );
  assert.throws(
    () => validateNodeReleaseWorkflow(`${workflow}\n      - run: gh release create node-v1.2.3\n`),
    /broadens/,
  );
});

test("rejects a runner context before a release job is assigned", () => {
  assert.throws(
    () =>
      validateNodeReleaseWorkflow(
        workflow.replace(
          "RELEASE_ROOT: ${{ github.workspace }}-node-release-${{ matrix.arch }}",
          "RELEASE_ROOT: ${{ runner.temp }}/openbot-node-release-${{ matrix.arch }}",
        ),
      ),
    /required|Required|broadens|immutable|reviewed|exact/,
  );
});

test("rejects moving action references and omitted attestations", () => {
  assert.throws(
    () =>
      validateNodeReleaseWorkflow(
        workflow.replace(
          "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          "actions/setup-node@v7",
        ),
      ),
    /required|Required|broadens|immutable|reviewed|exact/,
  );
  assert.throws(
    () =>
      validateNodeReleaseWorkflow(
        workflow.replace(
          "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          "actions/checkout@v7",
        ),
      ),
    /required|Required|broadens|immutable|reviewed|exact/,
  );
  assert.throws(
    () =>
      validateNodeReleaseWorkflow(
        workflow.replace(
          "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
          "actions/attest@v4",
        ),
      ),
    /exact attest pin|immutable/,
  );
  assert.throws(
    () =>
      validateNodeReleaseWorkflow(
        workflow.replace(
          / {6}- name: Attest archive SBOM[\s\S]*?(?= {6}- name: Upload archive for review)/,
          "",
        ),
      ),
    /missing|required|Required|exact attest pin/,
  );
});

test("rejects omitted ancestry, repeat-build, or direct-upload gates", () => {
  assert.throws(
    () =>
      validateNodeReleaseWorkflow(
        workflow.replace(
          'git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main',
          'git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/release',
        ),
      ),
    /required|Required|broadens|immutable|reviewed|exact/,
  );
  assert.throws(
    () =>
      validateNodeReleaseWorkflow(
        workflow.replace("npm run release:node-linux:archive --", "npm run omitted-archive --"),
      ),
    /construct each archive twice/,
  );
  assert.throws(
    () => validateNodeReleaseWorkflow(workflow.replace("          archive: false\n", "")),
    /directly upload all three/,
  );
  assert.throws(
    () =>
      validateNodeReleaseWorkflow(
        workflow.replace("npm run release:node-linux:smoke --", "npm run omitted-smoke --"),
      ),
    /required|Required|broadens|immutable|reviewed|exact/,
  );
});

test("accepts formatting, renamed steps and an extra pinned setup without layout counts", () => {
  const changed = parse(workflow);
  changed.name = "Reviewed Node artifacts";
  const job = changed.jobs["build-attest"];
  for (const step of job.steps) if (step.name) step.name = `Step: ${step.name.length}`;
  job.steps.splice(2, 0, structuredClone(job.steps[1]));
  assert.doesNotThrow(() => validateNodeReleaseWorkflow(stringify(changed, { indent: 4 })));
});

test("rejects conditional or ignored release evidence and incomplete compared outputs", () => {
  for (const mutate of [
    (job) => {
      job.steps.find((s) => s.run?.includes("release:node-linux:smoke")).if = false;
    },
    (job) => {
      job.steps.find((s) => s.run?.includes("release:node-linux:archive")).run =
        "# " +
        job.steps
          .find((s) => s.run?.includes("release:node-linux:archive"))
          .run.replaceAll("\n", "\n# ");
    },
    (job) => {
      job.steps.find((s) => s.with?.["sbom-path"]).if = false;
    },
    (job) => {
      job["continue-on-error"] = true;
    },
    (job) => {
      job.steps.find((s) => s.with?.path?.endsWith("*.SHA256SUMS")).with.path = "missing";
    },
  ]) {
    const changed = parse(workflow);
    mutate(changed.jobs["build-attest"]);
    assert.throws(() => validateNodeReleaseWorkflow(stringify(changed)));
  }
});
