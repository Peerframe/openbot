import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  assertPinnedSources,
  hasCommands,
  requiredJob,
  runs,
  workflowDocument,
} from "./workflow-policy.mjs";

const ATTEST = "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6";
const UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const ROOT = "${{ env.RELEASE_ROOT }}";
const artifacts = ["*.tar.xz", "*.build.json", "*.SHA256SUMS"].map(
  (name) => `${ROOT}/archives-1/${name}`,
);
const lines = (value) =>
  String(value ?? "")
    .trim()
    .split(/\s*\n\s*/)
    .filter(Boolean);

export function validateNodeReleaseWorkflow(source) {
  const workflow = workflowDocument(source);
  assert.deepEqual(
    workflow.on,
    { push: { tags: ["node-v*"] } },
    "Node release broadens its tag-only trigger.",
  );
  assert.deepEqual(
    workflow.permissions,
    { contents: "read", "id-token": "write", attestations: "write" },
    "Node release broadens required attestation authority.",
  );
  assert.equal(workflow.concurrency?.group, "node-linux-provenance-${{ github.ref }}");
  assert.equal(workflow.concurrency?.["cancel-in-progress"], false);
  assertPinnedSources(workflow);
  for (const job of Object.values(workflow.jobs)) {
    if (job.permissions)
      assert.deepEqual(
        job.permissions,
        workflow.permissions,
        "Node release broadens job authority.",
      );
    assert(
      !/gh release|create-release|action-gh-release|push-to-registry/.test(JSON.stringify(job)),
      "Node release broadens publication output.",
    );
  }
  const job = requiredJob(workflow, "build-attest");
  assert(!("if" in job), "Required release qualification cannot be bypassed.");
  assert.equal(job["runs-on"], "${{ matrix.runner }}");
  assert.equal(
    job.env?.RELEASE_ROOT,
    "${{ github.workspace }}-node-release-${{ matrix.arch }}",
    "Required release root must exist before runner assignment.",
  );
  assert.equal(job.strategy?.["fail-fast"], false);
  assert(
    Number.isInteger(job["timeout-minutes"]) &&
      job["timeout-minutes"] > 0 &&
      job["timeout-minutes"] <= 60,
    "Release qualification must remain bounded.",
  );
  assert.deepEqual(job.strategy.matrix.include.map((row) => `${row.arch}:${row.runner}`).sort(), [
    "arm64:ubuntu-24.04-arm",
    "x64:ubuntu-24.04",
  ]);
  assert(
    job.steps.some(
      (step) => step.uses?.startsWith("actions/checkout@") && step.with?.["fetch-depth"] === 0,
    ),
    "Required full release ancestry is missing.",
  );
  hasCommands(
    job,
    [
      'git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main',
      "^node-v[0-9]+\\.[0-9]+\\.[0-9]+",
      "https://nodejs.org/dist/v22.22.2/node-v22.22.2-linux-${RELEASE_ARCH}.tar.xz",
      "curl --fail --location --proto '=https' --tlsv1.2",
      "npm@10.9.9",
      "d60fba8cb42f688b81e33c2f1cbef2ad7b977166700ec0ad057f1b6d60ea6ef2524abf673e20c35931cd8305d1dbb8887134d6eefdc0e7b8435bd458bf65b862",
      "sha512sum --check --status",
      'test "$("$npm_cli" --version)" = \'10.9.9\'',
      "npm run release:node-linux:candidate --",
      '--source-commit "$GITHUB_SHA"',
      '--source-date-epoch "$SOURCE_DATE_EPOCH"',
      '--node-archive "$RUNTIME_ARCHIVE"',
      'sha256sum --check "$artifact.SHA256SUMS"',
      '/usr/bin/xz --test "$artifact"',
      "npm run release:node-linux:smoke --",
      '--arch "$RELEASE_ARCH"',
    ],
    "Required Node release",
  );
  for (const directory of ["archives-1", "archives-2"]) {
    const command = runs(job)
      .split("\n")
      .find(
        (line) =>
          line.includes("npm run release:node-linux:archive --") &&
          line.includes(`--out-dir "$RELEASE_ROOT/${directory}"`),
      );
    assert(
      command,
      "Required reproducibility builds must construct each archive twice into independent directories.",
    );
    for (const option of [
      '--candidate "$candidate"',
      "--dpkg-query /usr/bin/dpkg-query",
      "--gnu-tar /usr/bin/tar",
      "--xz /usr/bin/xz",
    ])
      assert(command.includes(option), `Required archive construction: missing ${option}`);
    hasCommands(job, [command], "Required archive construction");
  }
  for (const suffix of ["", ".build.json", ".SHA256SUMS"])
    hasCommands(
      job,
      [
        `cmp "$RELEASE_ROOT/archives-1/$artifact${suffix}" "$RELEASE_ROOT/archives-2/$artifact${suffix}"`,
      ],
      "Required repeat-build comparison",
    );
  const index = (fragment) =>
    job.steps.findIndex((step) => runs({ steps: [step] }).includes(fragment));
  const candidate = index("npm run release:node-linux:candidate --");
  const archive = index("npm run release:node-linux:archive --");
  const comparison = index('cmp "$RELEASE_ROOT/archives-1/');
  const smoke = index("npm run release:node-linux:smoke --");
  assert(
    candidate < archive && archive <= comparison && comparison < smoke,
    "Required release must build, compare, then smoke the native package.",
  );

  const provenance = new Set();
  const uploads = new Set();
  let sbom = false;
  let lastAttest = smoke;
  for (const [position, step] of job.steps.entries()) {
    if (step.uses?.startsWith("actions/attest@")) {
      assert.equal(step.uses, ATTEST, "Required exact attest pin.");
      assert(
        !("if" in step) && position > smoke,
        "Required attestations must follow successful smoke.",
      );
      const subjects = lines(step.with?.["subject-path"]);
      assert(
        subjects.length && subjects.every((path) => artifacts.includes(path)),
        "Attest actual compared review artifacts.",
      );
      if (step.with?.["sbom-path"]) {
        assert.equal(
          step.with["sbom-path"],
          ROOT +
            "/candidates/openbot-node-${{ steps.inputs.outputs.version }}-linux-${{ matrix.arch }}-unsigned/SBOM.spdx.json",
        );
        assert(subjects.includes(artifacts[0]), "SBOM must describe the native archive.");
        sbom = true;
      } else for (const path of subjects) provenance.add(path);
      lastAttest = position;
    }
    if (step.uses?.startsWith("actions/upload-artifact@")) {
      assert.equal(step.uses, UPLOAD, "Required reviewed upload pin.");
      assert(
        !("if" in step) && position > lastAttest && provenance.size === artifacts.length && sbom,
        "Required artifacts must be attested before direct upload.",
      );
      assert.equal(step.with?.["if-no-files-found"], "error");
      assert.equal(step.with?.overwrite, false);
      assert(
        Number.isInteger(step.with?.["retention-days"]) &&
          step.with["retention-days"] > 0 &&
          step.with["retention-days"] <= 14,
        "Bound review artifact retention.",
      );
      assert.equal(
        step.with?.archive,
        false,
        "Must directly upload all three review artifact kinds.",
      );
      const paths = lines(step.with?.path);
      assert(
        paths.length && paths.every((path) => artifacts.includes(path)),
        "Only compared release review artifacts may be uploaded.",
      );
      for (const path of paths) uploads.add(path);
    }
  }
  assert(
    sbom && artifacts.every((path) => provenance.has(path) && uploads.has(path)),
    "Required SBOM, provenance or review output is missing.",
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateNodeReleaseWorkflow(
    await readFile(new URL("../.github/workflows/node-linux-release.yml", import.meta.url), "utf8"),
  );
  console.info("Node Linux release workflow properties passed.");
}
