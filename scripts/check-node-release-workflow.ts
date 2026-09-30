import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  assertPinnedSources,
  fetchesFullHistory,
  field,
  hasCommands,
  matrixRows,
  requiredJob,
  runs,
  stepScript,
  workflowDocument,
} from "./workflow-policy.ts";

const ATTEST = "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6";
const UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const ROOT = "${{ env.RELEASE_ROOT }}";
const ARCHIVE = `${ROOT}/archives-1/*.tar.xz`;
const artifacts = [ARCHIVE, `${ROOT}/archives-1/*.build.json`, `${ROOT}/archives-1/*.SHA256SUMS`];
const lines = (value: unknown): string[] =>
  String(value ?? "")
    .trim()
    .split(/\s*\n\s*/)
    .filter(Boolean);

export function validateNodeReleaseWorkflow(source: string): void {
  const workflow = workflowDocument(source);
  assert.deepEqual(
    workflow.source.on,
    { push: { tags: ["node-v*"] } },
    "Node release broadens its tag-only trigger.",
  );
  assert.deepEqual(
    workflow.source.permissions,
    { contents: "read", "id-token": "write", attestations: "write" },
    "Node release broadens required attestation authority.",
  );
  assert.equal(
    field(workflow.source, "concurrency", "group"),
    "node-linux-provenance-${{ github.ref }}",
  );
  assert.equal(field(workflow.source, "concurrency", "cancel-in-progress"), false);
  assertPinnedSources(workflow);
  for (const job of workflow.jobs.values()) {
    if (job.source.permissions)
      assert.deepEqual(
        job.source.permissions,
        workflow.source.permissions,
        "Node release broadens job authority.",
      );
    assert(
      !/gh release|create-release|action-gh-release|push-to-registry/.test(
        JSON.stringify(job.source),
      ),
      "Node release broadens publication output.",
    );
  }
  const job = requiredJob(workflow, "build-attest");
  assert(!job.conditional, "Required release qualification cannot be bypassed.");
  assert.equal(job.source["runs-on"], "${{ matrix.runner }}");
  assert.equal(
    job.env.RELEASE_ROOT,
    "${{ github.workspace }}-node-release-${{ matrix.arch }}",
    "Required release root must exist before runner assignment.",
  );
  assert.equal(field(job.source, "strategy", "fail-fast"), false);
  const timeout = job.source["timeout-minutes"];
  assert(
    typeof timeout === "number" && Number.isInteger(timeout) && timeout > 0 && timeout <= 60,
    "Release qualification must remain bounded.",
  );
  assert.deepEqual(
    matrixRows(job)
      .map((row) => `${String(row.arch)}:${String(row.runner)}`)
      .sort(),
    ["arm64:ubuntu-24.04-arm", "x64:ubuntu-24.04"],
  );
  assert(fetchesFullHistory(job), "Required full release ancestry is missing.");
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
  const index = (fragment: string): number =>
    job.steps.findIndex((step) => stepScript(step).includes(fragment));
  const candidate = index("npm run release:node-linux:candidate --");
  const archive = index("npm run release:node-linux:archive --");
  const comparison = index('cmp "$RELEASE_ROOT/archives-1/');
  const smoke = index("npm run release:node-linux:smoke --");
  assert(
    candidate < archive && archive <= comparison && comparison < smoke,
    "Required release must build, compare, then smoke the native package.",
  );

  const provenance = new Set<string>();
  const uploads = new Set<string>();
  let sbom = false;
  let lastAttest = smoke;
  for (const [position, step] of job.steps.entries()) {
    if (step.uses?.startsWith("actions/attest@")) {
      assert.equal(step.uses, ATTEST, "Required exact attest pin.");
      assert(
        !step.conditional && position > smoke,
        "Required attestations must follow successful smoke.",
      );
      const subjects = lines(step.with["subject-path"]);
      assert(
        subjects.length && subjects.every((path) => artifacts.includes(path)),
        "Attest actual compared review artifacts.",
      );
      if (step.with["sbom-path"]) {
        assert.equal(
          step.with["sbom-path"],
          ROOT +
            "/candidates/openbot-node-${{ steps.inputs.outputs.version }}-linux-${{ matrix.arch }}-unsigned/SBOM.spdx.json",
        );
        assert(subjects.includes(ARCHIVE), "SBOM must describe the native archive.");
        sbom = true;
      } else for (const path of subjects) provenance.add(path);
      lastAttest = position;
    }
    if (step.uses?.startsWith("actions/upload-artifact@")) {
      assert.equal(step.uses, UPLOAD, "Required reviewed upload pin.");
      assert(
        !step.conditional && position > lastAttest && provenance.size === artifacts.length && sbom,
        "Required artifacts must be attested before direct upload.",
      );
      assert.equal(step.with["if-no-files-found"], "error");
      assert.equal(step.with.overwrite, false);
      const retention = step.with["retention-days"];
      assert(
        typeof retention === "number" &&
          Number.isInteger(retention) &&
          retention > 0 &&
          retention <= 14,
        "Bound review artifact retention.",
      );
      assert.equal(
        step.with.archive,
        false,
        "Must directly upload all three review artifact kinds.",
      );
      const paths = lines(step.with.path);
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
