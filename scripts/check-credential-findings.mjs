import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 16 * 1024 * 1024;
const REVIEWED_FIXTURES = Object.freeze([
  {
    detectorType: 968,
    detectorName: "Postgres",
    commit: "ed33238f866b52508bcce939e1f62fe2ad2faed4",
    file: "deploy/server/smoke-product.py",
    line: 58,
    raw: "e58bc479a694bb81fb43e7765c5d9171bfdb60acd80d816b1a3f69a8fee5f4e8",
    rawV2: "e58bc479a694bb81fb43e7765c5d9171bfdb60acd80d816b1a3f69a8fee5f4e8",
  },
  {
    detectorType: 87,
    detectorName: "SentryToken",
    commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
    file: "experiments/linux-execution/REAL_HOST_DEADLINE.json",
    line: 8,
    raw: "3488860627e07cf82ec8321f043b8f12578e7b01106da1d0cd0528ba73cc3af6",
    rawV2: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  {
    detectorType: 87,
    detectorName: "SentryToken",
    commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
    file: "experiments/linux-execution/protected_native.py",
    line: 24,
    raw: "15ff853549b0957c0de5f3e8db4edc74d4fbdc10fda10276d0bedf1b31c0d75f",
    rawV2: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  {
    detectorType: 968,
    detectorName: "Postgres",
    commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
    file: "apps/desktop/src/python-server.test.ts",
    line: 87,
    raw: "c6a2596aaaad66778be7c26f55d25dcbd4dbc54d5b985c4eca99ac02d9532c2e",
    rawV2: "c6a2596aaaad66778be7c26f55d25dcbd4dbc54d5b985c4eca99ac02d9532c2e",
  },
  {
    detectorType: 17,
    detectorName: "URI",
    commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
    file: "apps/server-python/tests/test_model_connections.py",
    line: 95,
    raw: "99829bbe372d9735dbb6bc6c0e37bd5c3915f2b358455788fca51621b8c4c997",
    rawV2: "99829bbe372d9735dbb6bc6c0e37bd5c3915f2b358455788fca51621b8c4c997",
  },
  {
    detectorType: 17,
    detectorName: "URI",
    commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
    file: "apps/server-python/tests/test_public_source.py",
    line: 76,
    raw: "1231625e7e70c4e56347672932d37a1c35eff89051483b37cbd09f7b9c58337e",
    rawV2: "1231625e7e70c4e56347672932d37a1c35eff89051483b37cbd09f7b9c58337e",
  },
  {
    detectorType: 17,
    detectorName: "URI",
    commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
    file: "apps/server-python/tests/test_public_source.py",
    line: 81,
    raw: "1231625e7e70c4e56347672932d37a1c35eff89051483b37cbd09f7b9c58337e",
    rawV2: "1231625e7e70c4e56347672932d37a1c35eff89051483b37cbd09f7b9c58337e",
  },
  {
    detectorType: 17,
    detectorName: "URI",
    commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
    file: "apps/server-python/tests/test_work_model_receipts_postgres.py",
    line: 44,
    raw: "d27f4ddbd325cde074e00ff1c583ebb6dfe5f649e8ed4a7782c0853cfbfd14bc",
    rawV2: "3637dbb5222f14ede4ee81c299ca7d04ad5f8492d40c1a52bfd84cb3347ddad6",
  },
  {
    detectorType: 87,
    detectorName: "SentryToken",
    commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
    file: "experiments/linux-execution/REAL_HOST_DEADLINE.json",
    line: 9,
    raw: "15ff853549b0957c0de5f3e8db4edc74d4fbdc10fda10276d0bedf1b31c0d75f",
    rawV2: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  {
    detectorType: 87,
    detectorName: "SentryToken",
    commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
    file: "experiments/linux-execution/protected_native.py",
    line: 24,
    raw: "3488860627e07cf82ec8321f043b8f12578e7b01106da1d0cd0528ba73cc3af6",
    rawV2: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  {
    detectorType: 17,
    detectorName: "URI",
    commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
    file: "packages/protocol/src/model-services.test.ts",
    line: 46,
    raw: "d88f84291a4085c5aa7a5c1aab71a7baf64065e805c8c2c60c51aabf7ec55af9",
    rawV2: "d88f84291a4085c5aa7a5c1aab71a7baf64065e805c8c2c60c51aabf7ec55af9",
  },
  {
    detectorType: 87,
    detectorName: "SentryToken",
    commit: "ef1e2545101766284a2104647015a4c5a5638dfc",
    file: "docs/research/s2-work-supervision.md",
    line: 73,
    raw: "5fb64d41242d2546f1713381ae57f7ea5b8e8e1e2f17023d63c7d3cc3c2e5de6",
    rawV2: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  {
    detectorType: 17,
    detectorName: "URI",
    commit: "cb057607a100ccc10dd4cec6eece6c9cfc4a5158",
    file: "apps/server/src/plugin-service.test.ts",
    line: 385,
    raw: "1231625e7e70c4e56347672932d37a1c35eff89051483b37cbd09f7b9c58337e",
    rawV2: "64af6524d4fcec9a8688550461aea8ddd09ec210db19f00be93ddc558b2b5ebb",
  },
  {
    detectorType: 17,
    detectorName: "URI",
    commit: "9cc73c9e78451e572f57d142d6b9caf62ccb78e2",
    file: "apps/server/src/model-web-tools.test.ts",
    line: 188,
    raw: "1231625e7e70c4e56347672932d37a1c35eff89051483b37cbd09f7b9c58337e",
    rawV2: "1231625e7e70c4e56347672932d37a1c35eff89051483b37cbd09f7b9c58337e",
  },
  {
    detectorType: 17,
    detectorName: "URI",
    commit: "c095669dbb4e241d2999867e3778b1b4408a83fa",
    file: "apps/desktop/src/desktop-support-links.test.ts",
    line: 29,
    raw: "5cb295befc1b5d1ef305b1741773eb77b2488034068900f6303cff28085306e9",
    rawV2: "867b18066ef99681db5cac0d82c24537671436661eb4e73669beaaece989885c",
  },
  {
    detectorType: 17,
    detectorName: "URI",
    commit: "e8fa933dbd94751ee01974bb16e53158760f1c26",
    file: "apps/server/src/native-web-tools.test.ts",
    line: 99,
    raw: "10a105928f8eee716169d4b157b0976a7ac565f1262cfb11c2aee2d4f711a07d",
    rawV2: "41a0b7336302d4c7c07f4f5620b3f87a03d8ef3c2e08a925d7eb91f3e54de986",
  },
  {
    detectorType: 968,
    detectorName: "Postgres",
    commit: "d854e2afa62c90455570fae502f9a1616d320794",
    file: "scripts/smoke-dev-fixture.test.mjs",
    line: 31,
    raw: "a0010550bccff9bf7c0aa79e783a4e21558de033364bf51b00eea5d850faa23f",
    rawV2: "a0010550bccff9bf7c0aa79e783a4e21558de033364bf51b00eea5d850faa23f",
  },
  {
    detectorType: 968,
    detectorName: "Postgres",
    commit: "716c2867beac3467be5eebe6b134e343b0523296",
    file: "scripts/verify-retained-upgrade.test.mjs",
    line: 20,
    raw: "23f48618df08767413e1310aa3a841b4384d4c687087792223e06e4141cb516a",
    rawV2: "23f48618df08767413e1310aa3a841b4384d4c687087792223e06e4141cb516a",
  },
]);

function digest(value) {
  return typeof value === "string" ? createHash("sha256").update(value).digest("hex") : undefined;
}

function reviewedFixture(finding) {
  const source = finding?.SourceMetadata?.Data?.Git;
  // This exception binds an immutable synthetic test line, never an entire file or detector.
  // Review evidence: docs/research/credential-scan-fixture-triage.md.
  return (
    finding?.Verified === false &&
    REVIEWED_FIXTURES.some(
      (fixture) =>
        finding.DetectorType === fixture.detectorType &&
        finding.DetectorName === fixture.detectorName &&
        source?.commit === fixture.commit &&
        source.file === fixture.file &&
        source.line === fixture.line &&
        digest(finding.Raw) === fixture.raw &&
        digest(finding.RawV2) === fixture.rawV2,
    )
  );
}

export function checkCredentialFindings(output, scannerExit) {
  if (scannerExit !== 0 && scannerExit !== 183) {
    throw new Error("Credential scanner failed; findings cannot override a scan error.");
  }
  if (Buffer.byteLength(output) > MAX_BYTES) {
    throw new Error("Credential scanner output exceeds the review limit.");
  }
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  if ((scannerExit === 0 && lines.length !== 0) || (scannerExit === 183 && lines.length === 0)) {
    throw new Error("Credential scanner exit and findings are inconsistent.");
  }
  for (const line of lines) {
    let finding;
    try {
      finding = JSON.parse(line);
    } catch {
      // JSON parser messages can contain candidate fragments; never forward them into CI logs.
      throw new Error("Credential scanner produced invalid JSON.");
    }
    if (!reviewedFixture(finding)) {
      throw new Error(
        "Unreviewed credential-like content detected; inspect locally without uploads.",
      );
    }
  }
  return { reviewedFixtures: lines.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [, , resultsPath, exitText] = process.argv;
    if (!resultsPath || !/^(0|183)$/.test(exitText ?? "")) {
      throw new Error("Credential scanner failed or its result arguments are invalid.");
    }
    if ((await stat(resultsPath)).size > MAX_BYTES) {
      throw new Error("Credential scanner output exceeds the review limit.");
    }
    const result = checkCredentialFindings(await readFile(resultsPath, "utf8"), Number(exitText));
    console.info(`Credential scan passed; ${result.reviewedFixtures} exact historical fixture(s).`);
  } catch {
    console.error(
      "Credential scan failed closed. Inspect results locally; candidate values are suppressed.",
    );
    process.exitCode = 1;
  }
}
