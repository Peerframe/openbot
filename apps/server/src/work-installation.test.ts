import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { entryOptions } from "./config.js";
import { loadWorkInstallation } from "./work-installation.js";
import { validateWorkOptions } from "./work-service.js";

it("loads the retained private deployment files into disjoint queues and explicit browser authority", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "work-installation-")));
  try {
    const temporal = join(root, "temporal.json"),
      browser = join(root, "browser.json"),
      command = join(root, "command.json");
    const engine = {
      temporal_address: "127.0.0.1:7233",
      namespace: "default",
      queue: "openbot-product-original",
      tls: {
        ca: join(root, "ca.pem"),
        certificate: join(root, "client.pem"),
        key: join(root, "client.key"),
        server_name: "temporal.test",
      },
    };
    writeFileSync(temporal, JSON.stringify(engine), { mode: 0o600 });
    const input = { temporal, fileRoot: join(root, "files"), tokenLimit: 100000 };
    const first = loadWorkInstallation(input);
    validateWorkOptions(first.work);
    assert.equal(first.legacyQueue, engine.queue);
    assert.equal("drainPythonQueue" in first.work, false);
    const selected = {
      OPENBOT_TS_PUBLIC_ORIGIN: "http://127.0.0.1:3101",
      OPENBOT_TS_DATABASE_URL: "postgres://127.0.0.1/disposable",
      OPENBOT_TS_OWNER_PASSWORD: "Synthetic-work-installation-password",
      OPENBOT_TS_OBJECT_ROOT: join(root, "objects"),
      OPENBOT_TS_MODEL_CONNECTION_KEY_PATH: join(root, "model.key"),
      OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: temporal,
      OPENBOT_TS_WORK_FILE_ROOT: input.fileRoot,
    };
    assert.deepEqual(entryOptions(selected).product?.work, first.work);
    for (const key of [
      "OPENBOT_TS_DATABASE_URL",
      "OPENBOT_TS_OWNER_PASSWORD",
      "OPENBOT_TS_OBJECT_ROOT",
      "OPENBOT_TS_MODEL_CONNECTION_KEY_PATH",
      "OPENBOT_TS_WORK_FILE_ROOT",
    ])
      assert.throws(() => entryOptions({ ...selected, [key]: undefined }));
    assert.throws(() => entryOptions({ ...selected, OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: "" }));
    assert.notEqual(first.work.taskQueue, engine.queue);
    assert.deepEqual(first, loadWorkInstallation(input));
    assert.deepEqual(first.workerRuntime, {
      browserRoutes: {},
      humanControl: false,
      legacyHumanControl: false,
    });
    const bot = "10000000-0000-4000-8000-000000000001";
    writeFileSync(
      browser,
      JSON.stringify({
        version: 1,
        routes: { [bot]: "worker" },
        humanControl: true,
        pageOrigins: { [bot]: ["https://example.invalid"] },
      }),
      { mode: 0o600 },
    );
    const configured = loadWorkInstallation({ ...input, browser, command });
    assert.deepEqual(configured.workerRuntime, {
      browserRoutes: { [bot]: "worker" },
      pageOrigins: { [bot]: ["https://example.invalid"] },
      humanControl: true,
      legacyHumanControl: false,
      command,
    });
    writeFileSync(temporal, JSON.stringify({ ...engine, queue: "another-original-queue" }));
    assert.notEqual(loadWorkInstallation(input).work.taskQueue, first.work.taskQueue);
    for (const raw of [
      JSON.stringify(engine).replace("{", '{"queue":"duplicate",'),
      JSON.stringify({ ...engine, databaseUrl: "postgresql://example.invalid/database" }),
      JSON.stringify({ ...engine, execution_timeout_seconds: 1.5 }),
    ]) {
      writeFileSync(temporal, raw);
      assert.throws(() => loadWorkInstallation(input), /work_installation_invalid/);
    }
    writeFileSync(temporal, JSON.stringify(engine));
    chmodSync(temporal, 0o644);
    assert.throws(() => loadWorkInstallation(input), /work_installation_invalid/);
    chmodSync(temporal, 0o600);
    const alias = join(root, "alias.json");
    symlinkSync(temporal, alias);
    assert.throws(
      () => loadWorkInstallation({ ...input, temporal: alias }),
      /work_installation_invalid/,
    );
    writeFileSync(
      browser,
      JSON.stringify({
        version: 1,
        routes: {},
        humanControl: true,
        pageOrigins: { [bot]: ["https://example.invalid"] },
      }),
    );
    assert.throws(() => loadWorkInstallation({ ...input, browser }), /work_installation_invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
