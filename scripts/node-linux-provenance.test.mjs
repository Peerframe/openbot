import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LINUX_INSTALL_PROVENANCE_POLICY,
  linuxProvenanceCertificateIdentity,
} from "./node-linux-install-transaction.mjs";
import {
  LINUX_PROVENANCE_VERIFIER,
  linuxAttestationVerifyArguments,
  runBoundedCommand,
  verifyLinuxReleaseProvenance,
} from "./node-linux-provenance.mjs";
import { sha256File } from "./release-source.ts";

const version = "1.2.3";
const sourceCommit = "a".repeat(40);
const fixedTime = new Date("2026-09-04T03:04:05.000Z");

test("builds an exact GitHub attestation policy without the prefix matcher", () => {
  const archivePath = "/tmp/openbot-node-1.2.3-linux-x64-unsigned.tar.xz";
  const arguments_ = linuxAttestationVerifyArguments({ archivePath, sourceCommit, version });

  assert.deepEqual(arguments_, [
    "attestation",
    "verify",
    archivePath,
    "--repo",
    "yxflc11/openbot",
    "--cert-identity",
    linuxProvenanceCertificateIdentity(version),
    "--source-ref",
    "refs/tags/node-v1.2.3",
    "--source-digest",
    sourceCommit,
    "--predicate-type",
    "https://slsa.dev/provenance/v1",
    "--cert-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    "--deny-self-hosted-runners",
    "--digest-alg",
    "sha256",
    "--hostname",
    "github.com",
    "--format",
    "json",
    "--limit",
    "30",
  ]);
  assert.equal(arguments_.includes("--signer-workflow"), false);
});

test("derives trusted provenance only after exact gh verification", async () => {
  await withArchive(async (archivePath) => {
    const archiveSha256 = await sha256File(archivePath);
    const requests = [];
    const commandRunner = async (request) => {
      requests.push(request);
      if (request.arguments[0] === "--version") return versionResult();
      return successResult(verificationJson(archiveSha256, { repository: "attacker/controlled" }));
    };

    const provenance = await verifyLinuxReleaseProvenance({
      archivePath,
      commandRunner,
      now: () => fixedTime,
      sourceCommit,
      version,
    });

    assert.deepEqual(provenance, {
      schemaVersion: 1,
      ...LINUX_INSTALL_PROVENANCE_POLICY,
      archiveSha256,
      certificateIdentity: linuxProvenanceCertificateIdentity(version),
      sourceCommit,
      sourceRef: "refs/tags/node-v1.2.3",
      verifiedAt: fixedTime.toISOString(),
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].executable, "/usr/bin/gh");
    assert.deepEqual(requests[0].arguments, ["--version"]);
    assert.equal(requests[0].environment.GH_HOST, "github.com");
    assert.equal(requests[0].environment.GH_PROMPT_DISABLED, "1");
    assert.equal("HOME" in requests[0].environment, false);
    assert.deepEqual(
      requests[1].arguments,
      linuxAttestationVerifyArguments({ archivePath, sourceCommit, version }),
    );
  });
});

test("fails closed on the wrong gh release or a failed command", async () => {
  await withArchive(async (archivePath) => {
    await assert.rejects(
      verifyLinuxReleaseProvenance({
        archivePath,
        commandRunner: async () => successResult(Buffer.from("gh version 2.94.0 (2026-06-01)\n")),
        sourceCommit,
        version,
      }),
      /version does not match/,
    );

    await assert.rejects(
      verifyLinuxReleaseProvenance({
        archivePath,
        commandRunner: async () => ({
          exitCode: 1,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("untrusted secret detail"),
        }),
        sourceCommit,
        version,
      }),
      (error) => {
        assert.equal(error.message, "Linux provenance verifier command failed.");
        assert.doesNotMatch(error.message, /secret/u);
        return true;
      },
    );
  });
});

test("rejects malformed, empty, ambiguous, and mismatched verification JSON", async () => {
  await withArchive(async (archivePath) => {
    const archiveSha256 = await sha256File(archivePath);
    const invalidOutputs = [
      Buffer.from("not-json"),
      Buffer.from("[]"),
      verificationJson(archiveSha256, undefined, 2),
      verificationJson("b".repeat(64)),
      verificationJson(archiveSha256, undefined, 1, "https://example.test/wrong"),
    ];

    for (const output of invalidOutputs) {
      let invocation = 0;
      await assert.rejects(
        verifyLinuxReleaseProvenance({
          archivePath,
          commandRunner: async () => {
            invocation += 1;
            return invocation === 1 ? versionResult() : successResult(output);
          },
          sourceCommit,
          version,
        }),
        /Linux provenance verifier/u,
      );
    }
  });
});

test("rejects an archive changed while provenance is being verified", async () => {
  await withArchive(async (archivePath) => {
    const archiveSha256 = await sha256File(archivePath);
    let invocation = 0;
    await assert.rejects(
      verifyLinuxReleaseProvenance({
        archivePath,
        commandRunner: async () => {
          invocation += 1;
          if (invocation === 1) return versionResult();
          await writeFile(archivePath, "changed after gh opened the archive");
          return successResult(verificationJson(archiveSha256));
        },
        sourceCommit,
        version,
      }),
      /changed during provenance verification/,
    );
  });
});

test("rejects archive symlinks and files outside the reviewed size bound", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-provenance-path-"));
  try {
    const small = path.join(root, "small.tar.xz");
    const large = path.join(root, "large.tar.xz");
    const link = path.join(root, "linked.tar.xz");
    await writeFile(small, "small");
    await writeFile(large, "");
    await truncate(large, 20 * 1024 * 1024);
    await symlink(large, link);
    for (const archivePath of [small, link]) {
      await assert.rejects(
        verifyLinuxReleaseProvenance({ archivePath, sourceCommit, version }),
        /reviewed-size regular file/,
      );
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("bounds subprocess time and output without exposing child output", async () => {
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const successful = await runBoundedCommand({
    executable: process.execPath,
    arguments: ["-e", "process.stdout.write('ok')"],
    environment,
    timeoutMs: 1_000,
    maximumBytes: 64,
  });
  assert.equal(successful.exitCode, 0);
  assert.equal(successful.signal, null);
  assert.equal(successful.stdout.toString("utf8"), "ok");
  assert.equal(successful.stderr.length, 0);

  await assert.rejects(
    runBoundedCommand({
      executable: process.execPath,
      arguments: ["-e", "setInterval(() => {}, 1000)"],
      environment,
      timeoutMs: 25,
      maximumBytes: 64,
    }),
    /command failed/,
  );
  await assert.rejects(
    runBoundedCommand({
      executable: process.execPath,
      arguments: ["-e", "process.stdout.write('sensitive'.repeat(20))"],
      environment,
      timeoutMs: 1_000,
      maximumBytes: 64,
    }),
    (error) => {
      assert.equal(error.message, "Linux provenance verifier command failed.");
      assert.doesNotMatch(error.message, /sensitive/u);
      return true;
    },
  );

  const controller = new AbortController();
  const aborted = runBoundedCommand({
    executable: process.execPath,
    arguments: ["-e", "setInterval(() => {}, 1000)"],
    environment,
    timeoutMs: 1_000,
    maximumBytes: 64,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(aborted, /command failed/);
});

async function withArchive(operation) {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-provenance-"));
  const archivePath = path.join(root, "openbot-node-1.2.3-linux-x64-unsigned.tar.xz");
  try {
    await writeFile(archivePath, "");
    await truncate(archivePath, 20 * 1024 * 1024);
    return await operation(archivePath);
  } finally {
    await rm(root, { recursive: true });
  }
}

function versionResult() {
  return successResult(
    Buffer.from(
      `${LINUX_PROVENANCE_VERIFIER.versionLine}\nhttps://github.com/cli/cli/releases/tag/v2.93.0\n`,
    ),
  );
}

function successResult(stdout) {
  return { exitCode: 0, signal: null, stdout, stderr: Buffer.alloc(0) };
}

function verificationJson(digest, predicate = {}, count = 1, predicateType) {
  const result = {
    attestation: {},
    verificationResult: {
      statement: {
        predicate,
        predicateType: predicateType ?? LINUX_INSTALL_PROVENANCE_POLICY.predicateType,
        subject: [{ digest: { sha256: digest }, name: "archive.tar.xz" }],
      },
    },
  };
  return Buffer.from(JSON.stringify(Array.from({ length: count }, () => result)));
}
