// Source development uses the same Python product entry and canonical SQL migrator.
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DevProcessOwner } from "./dev-processes.ts";

type ControlEnv = NodeJS.ProcessEnv & {
  OPENBOT_CONTROL_AUTHORITY: string;
  OPENBOT_CONTROL_HOST: string;
  OPENBOT_CONTROL_PORT: string;
  OPENBOT_CONTROL_COOKIE_MODE: string;
  OPENBOT_CONTROL_ALLOWED_ORIGINS: string;
  OPENBOT_CONTROL_NODE_EXECUTABLE: string;
  OPENBOT_CONTROL_NODE_MODULE_ROOT: string;
  OPENBOT_CONTROL_OBJECT_ROOT: string;
  OPENBOT_CONTROL_ARTIFACT_ROOT: string;
  OPENBOT_CONTROL_MODEL_DIRECTORY: string;
  OPENBOT_CONTROL_DATABASE_URL: string;
  OPENBOT_CONTROL_OWNER_PASSWORD: string;
  PYTHONDONTWRITEBYTECODE: string;
};

function parseDevArgs(argv: readonly string[]): { readonly serverOnly: boolean } {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--server-only")) {
    throw new Error("Only --server-only is supported.");
  }
  return { serverOnly: argv.includes("--server-only") };
}

async function prepareControlEnv(root: string, base: NodeJS.ProcessEnv): Promise<ControlEnv> {
  const databaseUrl = base.OPENBOT_CONTROL_DATABASE_URL;
  const ownerPassword = base.OPENBOT_CONTROL_OWNER_PASSWORD;
  if (!databaseUrl || !ownerPassword) {
    throw new Error(
      "Set OPENBOT_CONTROL_DATABASE_URL and OPENBOT_CONTROL_OWNER_PASSWORD explicitly; see .env.example.",
    );
  }
  const objectRoot = resolve(
    root,
    base.OPENBOT_CONTROL_OBJECT_ROOT ?? "data/python-product/objects",
  );
  const artifactRoot = resolve(
    root,
    base.OPENBOT_CONTROL_ARTIFACT_ROOT ?? "data/python-product/artifacts",
  );
  const modelDirectory = resolve(
    root,
    base.OPENBOT_CONTROL_MODEL_DIRECTORY ?? "data/python-product/model",
  );
  for (const path of [objectRoot, artifactRoot, modelDirectory]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  return {
    ...base,
    OPENBOT_CONTROL_DATABASE_URL: databaseUrl,
    OPENBOT_CONTROL_OWNER_PASSWORD: ownerPassword,
    OPENBOT_CONTROL_AUTHORITY: "product",
    OPENBOT_CONTROL_HOST: "127.0.0.1",
    OPENBOT_CONTROL_PORT: "3001",
    OPENBOT_CONTROL_COOKIE_MODE: base.OPENBOT_CONTROL_COOKIE_MODE ?? "loopback",
    OPENBOT_CONTROL_ALLOWED_ORIGINS:
      base.OPENBOT_CONTROL_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173",
    OPENBOT_CONTROL_NODE_EXECUTABLE: process.execPath,
    OPENBOT_CONTROL_NODE_MODULE_ROOT: resolve(root, "node_modules"),
    OPENBOT_CONTROL_OBJECT_ROOT: objectRoot,
    OPENBOT_CONTROL_ARTIFACT_ROOT: artifactRoot,
    OPENBOT_CONTROL_MODEL_DIRECTORY: modelDirectory,
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

const root = fileURLToPath(new URL("../", import.meta.url));
const { serverOnly } = parseDevArgs(process.argv.slice(2));
const python = resolve(root, "apps/server-python/.worker-venv/bin/python");
await access(python).catch(() => {
  throw new Error("Prepare Python first: apps/server-python/scripts/bootstrap-worker.sh");
});
const env = await prepareControlEnv(root, process.env);
const owner = new DevProcessOwner({ cwd: root, graceMs: 12_000 });
const stopAfterSignal = (): void => {
  void owner.stop().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
};
process.once("SIGTERM", stopAfterSignal);
process.once("SIGINT", stopAfterSignal);

function assertNotStopping(): void {
  if (owner.stopping) throw new Error("Development startup interrupted.");
}

try {
  await owner.waitSuccess(
    owner.start(
      python,
      ["-I", "apps/server-python/scripts/verify_environment.py", "--worker"],
      env,
    ),
  );
  assertNotStopping();
  await owner.waitSuccess(
    owner.start(
      process.execPath,
      [
        "node_modules/turbo/bin/turbo",
        "run",
        "build",
        "--filter=@openbot/python-node-runtime",
        "--filter=@openbot/web^...",
      ],
      env,
    ),
  );
  assertNotStopping();
  await owner.waitSuccess(
    owner.start(process.execPath, ["deploy/server/product-migrate.ts"], {
      ...env,
      OPENBOT_DATABASE_URL: env.OPENBOT_CONTROL_DATABASE_URL,
    }),
  );
  assertNotStopping();
  const running: Promise<void>[] = [
    owner.waitSuccess(
      owner.start(python, ["-I", "-B", "apps/server-python/scripts/serve.py"], env),
    ),
  ];
  if (!serverOnly) {
    running.push(
      owner.waitSuccess(
        owner.start(process.execPath, ["node_modules/vite/bin/vite.js", "apps/web"], env),
      ),
    );
  }
  await Promise.race(running);
} catch (error) {
  if (!owner.stopping) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
} finally {
  await owner.stop();
}
