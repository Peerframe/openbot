import assert from "node:assert/strict";
import test from "node:test";
import { checkCredentialFindings } from "./check-credential-findings.ts";

interface Finding {
  DetectorType: number;
  DetectorName: string;
  Verified?: boolean;
  Raw: string;
  RawV2: string;
  SourceMetadata: { Data: { Git: { commit: string; file: string; line: number } } };
}

function fixture(index = 0): Finding {
  if (index >= 27) {
    const definitions = [
      {
        detectorType: 968,
        detectorName: "Postgres",
        file: "apps/server/src/logging.test.ts",
        line: 8,
        raw: "postgres://secret:p" + "assword@private:5432",
        rawV2: "postgres://secret:p" + "assword@private:5432",
      },
      {
        detectorType: 87,
        detectorName: "SentryToken",
        file: "experiments/linux-execution/native-config.ts",
        line: 16,
        raw: "3315d7ad7c2d3751d349e4976fa02da1" + "da6fd7e41746c35622304e5fabe4fce0",
        rawV2: "",
      },
      {
        detectorType: 17,
        detectorName: "URI",
        file: "scripts/integration/fixtures/web-contract-compatibility.json",
        line: 16842,
        raw: syntheticUrl("https://example.invalid", "user", "synthetic").replace(/\/$/, ""),
        rawV2: syntheticUrl("https://example.invalid/v1", "user", "synthetic"),
      },
    ];
    const item = definitions[index - 27];
    if (!item) throw new RangeError("Unknown P5 credential fixture");
    return {
      DetectorType: item.detectorType,
      DetectorName: item.detectorName,
      Verified: false,
      Raw: item.raw,
      RawV2: item.rawV2 ?? item.raw,
      SourceMetadata: {
        Data: {
          Git: {
            commit: "eea544559a88ea70addf935624b7e00ee21cd22f",
            file: item.file,
            line: item.line,
          },
        },
      },
    };
  }
  if (index >= 22) {
    const definitions = [
      {
        base: "http://127.0.0.1:3102",
        password: "pass",
        file: "apps/server-ts/src/app.test.ts",
        line: 482,
      },
      {
        base: "https://example.invalid/v1",
        password: "synthetic",
        file: "apps/server-python/scripts/control-contract-fixtures.py",
        line: 1152,
      },
      {
        base: "https://public.example",
        password: "pass",
        file: "apps/server-python/tests/test_proxy_peer.py",
        line: 76,
      },
      {
        base: "http://127.0.0.1:3002/mcp",
        password: "secret",
        file: "packages/contract-tests/src/work.test.ts",
        line: 268,
      },
      {
        base: "https://example.com",
        password: "password",
        file: "packages/contract-tests/src/work.test.ts",
        line: 75,
      },
    ];
    const definition = definitions[index - 22];
    if (definition === undefined) throw new RangeError(`Unknown credential fixture: ${index}`);
    const rawV2 = syntheticUrl(definition.base, "user", definition.password);
    const authority = new URL(rawV2);
    authority.pathname = "/";
    return {
      DetectorType: 17,
      DetectorName: "URI",
      Verified: false,
      Raw: authority.href.slice(0, -1),
      RawV2: rawV2,
      SourceMetadata: {
        Data: {
          Git: {
            commit: "a240b810ea08bde29004e947b0ffc0298ad8dd1a",
            file: definition.file,
            line: definition.line,
          },
        },
      },
    };
  }
  if (index === 21) {
    const value = fixture(19);
    value.Raw = "5fb64d41242d2546f1713381ae57f7ea5" + "b8e8e1e2f17023d63c7d3cc3c2e5de6";
    value.SourceMetadata.Data.Git = {
      commit: "2512a615dde281c6157ecb21c9d72e85ef4674d7",
      file: "docs/research/credential-scan-fixture-triage.md",
      line: 237,
    };
    return value;
  }
  if (index === 18) {
    const raw = syntheticUrl("https://github.com", "user", "token");
    return {
      DetectorType: 17,
      DetectorName: "URI",
      Verified: false,
      Raw: raw,
      RawV2: raw,
      SourceMetadata: {
        Data: {
          Git: {
            commit: "e836e82f61cbb780a1976ed57c9f96a21a991df3",
            file: "packages/protocol/src/plugin-catalog.test.ts",
            line: 27,
          },
        },
      },
    };
  }
  if (index === 19) {
    const value = fixture(14);
    value.SourceMetadata.Data.Git.commit = "0a9fc212737f0f795999685d96b3d39efc2bf784";
    return value;
  }
  if (index === 20) {
    const value = fixture(4);
    value.SourceMetadata.Data.Git.commit = "b19a017e35e53855649e1c87ab31cf0f63d85974";
    return value;
  }
  if (index === 17) {
    const raw =
      "postgres://" + "openbot:" + "synthetic-product-db@" + String.fromCharCode(92) + ":5432";
    return {
      DetectorType: 968,
      DetectorName: "Postgres",
      Verified: false,
      Raw: raw,
      RawV2: raw,
      SourceMetadata: {
        Data: {
          Git: {
            commit: "ed33238f866b52508bcce939e1f62fe2ad2faed4",
            file: "deploy/server/smoke-product.py",
            line: 58,
          },
        },
      },
    };
  }
  if (index >= 6) return migrationFixture(index - 6);
  // Construct intentionally invalid inputs without creating fresh literal scanner matches.
  const definitions = [
    {
      url: "https://example.com",
      password: "pass",
      commit: "9cc73c9e78451e572f57d142d6b9caf62ccb78e2",
      file: "apps/server/src/model-web-tools.test.ts",
      line: 188,
    },
    {
      url: "https://github.com/yxflc11/openbot/issues/new",
      password: "password",
      commit: "c095669dbb4e241d2999867e3778b1b4408a83fa",
      file: "apps/desktop/src/desktop-support-links.test.ts",
      line: 29,
    },
    {
      url: "https://api.moonshot.cn/v1",
      password: "password",
      commit: "e8fa933dbd94751ee01974bb16e53158760f1c26",
      file: "apps/server/src/native-web-tools.test.ts",
      line: 99,
    },
    {
      url: "https://example.com/mcp",
      password: "pass",
      commit: "cb057607a100ccc10dd4cec6eece6c9cfc4a5158",
      file: "apps/server/src/plugin-service.test.ts",
      line: 385,
    },
    {
      url: "postgres://example.com:5432",
      username: "fixture",
      password: "synthetic",
      commit: "d854e2afa62c90455570fae502f9a1616d320794",
      file: "scripts/smoke-dev-fixture.test.mjs",
      line: 31,
    },
    {
      url: "postgres://db.example.com:5432",
      username: "private",
      password: "secret",
      commit: "716c2867beac3467be5eebe6b134e343b0523296",
      file: "scripts/verify-retained-upgrade.test.mjs",
      line: 20,
    },
  ];
  const definition = definitions[index];
  if (definition === undefined) throw new RangeError(`Unknown credential fixture: ${index}`);
  const url = new URL(definition.url);
  const postgres = url.protocol === "postgres:";
  url.username = definition.username ?? "user";
  url.password = definition.password;
  const rawV2 = index === 0 ? url.href.slice(0, -1) : url.href;
  url.pathname = "/";
  return {
    DetectorType: postgres ? 968 : 17,
    DetectorName: postgres ? "Postgres" : "URI",
    Verified: false,
    Raw: url.href.slice(0, -1),
    RawV2: rawV2,
    SourceMetadata: {
      Data: { Git: { commit: definition.commit, file: definition.file, line: definition.line } },
    },
  };
}

function syntheticUrl(base: string, username: string, password: string): string {
  const url = new URL(base);
  url.username = username;
  url.password = password;
  return url.href.endsWith("/") ? url.href.slice(0, -1) : url.href;
}
function migrationFixture(index: number): Finding {
  const extra: Finding[] = [
    {
      DetectorType: 87,
      DetectorName: "SentryToken",
      Verified: false,
      Raw: "3315d7ad7c2d3751d349e4976fa02da1" + "da6fd7e41746c35622304e5fabe4fce0",
      RawV2: "",
      SourceMetadata: {
        Data: {
          Git: {
            commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
            file: "experiments/linux-execution/REAL_HOST_DEADLINE.json",
            line: 8,
          },
        },
      },
    },
    {
      DetectorType: 87,
      DetectorName: "SentryToken",
      Verified: false,
      Raw: "aff3ed7dfac54b04aab14de2dde53e02" + "1402f0ba238bc7ece3ac7d4b6604b055",
      RawV2: "",
      SourceMetadata: {
        Data: {
          Git: {
            commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
            file: "experiments/linux-execution/protected_native.py",
            line: 24,
          },
        },
      },
    },
  ];
  const findings: Finding[] = [
    {
      DetectorType: 968,
      DetectorName: "Postgres",
      Verified: false,
      Raw: syntheticUrl("postgres://example.com:5432", "user", "secret"),
      RawV2: syntheticUrl("postgres://example.com:5432", "user", "secret"),
      SourceMetadata: {
        Data: {
          Git: {
            commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
            file: "apps/desktop/src/python-server.test.ts",
            line: 87,
          },
        },
      },
    },
    {
      DetectorType: 17,
      DetectorName: "URI",
      Verified: false,
      Raw: syntheticUrl("https://localhost", "user", "pass"),
      RawV2: syntheticUrl("https://localhost", "user", "pass"),
      SourceMetadata: {
        Data: {
          Git: {
            commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
            file: "apps/server-python/tests/test_model_connections.py",
            line: 95,
          },
        },
      },
    },
    {
      DetectorType: 17,
      DetectorName: "URI",
      Verified: false,
      Raw: syntheticUrl("https://example.com", "user", "pass"),
      RawV2: syntheticUrl("https://example.com", "user", "pass"),
      SourceMetadata: {
        Data: {
          Git: {
            commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
            file: "apps/server-python/tests/test_public_source.py",
            line: 76,
          },
        },
      },
    },
    {
      DetectorType: 17,
      DetectorName: "URI",
      Verified: false,
      Raw: syntheticUrl("https://example.com", "user", "pass"),
      RawV2: syntheticUrl("https://example.com", "user", "pass"),
      SourceMetadata: {
        Data: {
          Git: {
            commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
            file: "apps/server-python/tests/test_public_source.py",
            line: 81,
          },
        },
      },
    },
    {
      DetectorType: 17,
      DetectorName: "URI",
      Verified: false,
      Raw: syntheticUrl("https://api.example", "name", "secret"),
      RawV2: syntheticUrl("https://api.example/v1", "name", "secret"),
      SourceMetadata: {
        Data: {
          Git: {
            commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
            file: "apps/server-python/tests/test_work_model_receipts_postgres.py",
            line: 44,
          },
        },
      },
    },
    {
      DetectorType: 87,
      DetectorName: "SentryToken",
      Verified: false,
      Raw: "aff3ed7dfac54b04aab14de2dde53e02" + "1402f0ba238bc7ece3ac7d4b6604b055",
      RawV2: "",
      SourceMetadata: {
        Data: {
          Git: {
            commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
            file: "experiments/linux-execution/REAL_HOST_DEADLINE.json",
            line: 9,
          },
        },
      },
    },
    {
      DetectorType: 87,
      DetectorName: "SentryToken",
      Verified: false,
      Raw: "3315d7ad7c2d3751d349e4976fa02da1" + "da6fd7e41746c35622304e5fabe4fce0",
      RawV2: "",
      SourceMetadata: {
        Data: {
          Git: {
            commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
            file: "experiments/linux-execution/protected_native.py",
            line: 24,
          },
        },
      },
    },
    {
      DetectorType: 17,
      DetectorName: "URI",
      Verified: false,
      Raw: syntheticUrl("https://example.test", "user", "pass"),
      RawV2: syntheticUrl("https://example.test", "user", "pass"),
      SourceMetadata: {
        Data: {
          Git: {
            commit: "778236bdb01014f62aa590e22389263a4c5ec4ee",
            file: "packages/protocol/src/model-services.test.ts",
            line: 46,
          },
        },
      },
    },
    {
      DetectorType: 87,
      DetectorName: "SentryToken",
      Verified: false,
      Raw: "305c2893b58033c1d25cc2ae7f75ef94" + "c8684c86c9523d319d7b99924fc2f8c8",
      RawV2: "",
      SourceMetadata: {
        Data: {
          Git: {
            commit: "ef1e2545101766284a2104647015a4c5a5638dfc",
            file: "docs/research/s2-work-supervision.md",
            line: 73,
          },
        },
      },
    },
  ];
  const finding = index >= 9 ? extra[index - 9] : findings[index];
  if (finding === undefined) throw new RangeError(`Unknown migration fixture: ${index}`);
  return finding;
}

test("accepts clean scans and only the thirty exact reviewed historical findings", () => {
  assert.deepEqual(checkCredentialFindings("", 0), { reviewedFixtures: 0 });
  const findings = Array.from({ length: 30 }, (_, index) => index).map((index) =>
    JSON.stringify(fixture(index)),
  );
  for (const [index, finding] of findings.entries())
    assert.doesNotThrow(
      () => assert.deepEqual(checkCredentialFindings(finding, 183), { reviewedFixtures: 1 }),
      `fixture ${index}`,
    );
  assert.deepEqual(checkCredentialFindings(findings.join("\n"), 183), { reviewedFixtures: 30 });
});

test("does not exempt another value, detector, verified result, or source location", () => {
  const mutations: ReadonlyArray<(value: Finding) => void> = [
    (value) => {
      value.Raw += "different";
    },
    (value) => {
      value.RawV2 += "different";
    },
    (value) => {
      value.DetectorType = 1;
    },
    (value) => {
      value.DetectorName = "Other";
    },
    (value) => {
      const postgres = value.DetectorType === 968;
      value.DetectorType = postgres ? 17 : 968;
      value.DetectorName = postgres ? "URI" : "Postgres";
    },
    (value) => {
      value.Verified = true;
    },
    (value) => {
      delete value.Verified;
    },
    (value) => {
      value.SourceMetadata.Data.Git.commit = "a".repeat(40);
    },
    (value) => {
      value.SourceMetadata.Data.Git.file = "another.test.ts";
    },
    (value) => {
      value.SourceMetadata.Data.Git.line += 1;
    },
  ];
  for (const index of Array.from({ length: 30 }, (_, index) => index))
    for (const mutate of mutations) {
      const value = fixture(index);
      mutate(value);
      assert.throws(() => checkCredentialFindings(JSON.stringify(value), 183), /Unreviewed/);
      assert.throws(
        () =>
          checkCredentialFindings(
            [fixture(), value].map((finding) => JSON.stringify(finding)).join("\n"),
            183,
          ),
        /Unreviewed/,
      );
    }
});

test("fails closed on scanner errors, inconsistent results, malformed and oversized output", () => {
  for (const code of [1, 2, 125, 137, undefined, NaN]) {
    assert.throws(() => checkCredentialFindings(JSON.stringify(fixture()), code), /scan error/);
  }
  assert.throws(() => checkCredentialFindings("", 183), /inconsistent/);
  assert.throws(() => checkCredentialFindings(JSON.stringify(fixture()), 0), /inconsistent/);
  for (const output of ["null", "[]", "{}", "42"]) {
    assert.throws(() => checkCredentialFindings(output, 183), /Unreviewed/);
  }
  assert.throws(() => checkCredentialFindings(" ".repeat(16 * 1024 * 1024 + 1), 0), /limit/);
  const candidate = "sensitive-candidate-must-never-be-printed";
  assert.throws(
    () => checkCredentialFindings(`{"Raw":"${candidate}`, 183),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Credential scanner produced invalid JSON.");
      assert.ok(!error.message.includes(candidate));
      return true;
    },
  );
});
