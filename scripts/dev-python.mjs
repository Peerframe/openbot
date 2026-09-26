// Source development uses the same Python product entry and canonical SQL migrator.
import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--server-only"))
  throw new Error("Only --server-only is supported.");
const python = resolve(root, "apps/server-python/.worker-venv/bin/python");
await access(python).catch(() => {
  throw new Error("Prepare Python first: apps/server-python/scripts/bootstrap-worker.sh");
});
const env = { ...process.env };
if (!env.OPENBOT_CONTROL_DATABASE_URL || !env.OPENBOT_CONTROL_OWNER_PASSWORD)
  throw new Error(
    "Set OPENBOT_CONTROL_DATABASE_URL and OPENBOT_CONTROL_OWNER_PASSWORD explicitly; see .env.example.",
  );
Object.assign(env, {
  OPENBOT_CONTROL_AUTHORITY: "product",
  OPENBOT_CONTROL_HOST: "127.0.0.1",
  OPENBOT_CONTROL_PORT: "3001",
  OPENBOT_CONTROL_COOKIE_MODE: env.OPENBOT_CONTROL_COOKIE_MODE ?? "loopback",
  OPENBOT_CONTROL_ALLOWED_ORIGINS:
    env.OPENBOT_CONTROL_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173",
  OPENBOT_CONTROL_NODE_EXECUTABLE: process.execPath,
  OPENBOT_CONTROL_NODE_MODULE_ROOT: resolve(root, "node_modules"),
  PYTHONDONTWRITEBYTECODE: "1",
});
for (const [key, suffix] of [
  ["OPENBOT_CONTROL_OBJECT_ROOT", "objects"],
  ["OPENBOT_CONTROL_ARTIFACT_ROOT", "artifacts"],
  ["OPENBOT_CONTROL_MODEL_DIRECTORY", "model"],
]) {
  env[key] = resolve(root, env[key] ?? `data/python-product/${suffix}`);
  await mkdir(env[key], { recursive: true, mode: 0o700 });
}
const children = new Set();
let stopping = false;
function start(command, arguments_, environment = env) {
  const child = spawn(command, arguments_, { cwd: root, env: environment, stdio: "inherit" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
function completion(child) {
  return new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? accept() : reject(new Error(`Development process exited (${signal ?? code}).`)),
    );
  });
}
async function stop() {
  stopping = true;
  const pending = [...children].map((child) => {
    const done = new Promise((accept) => child.once("exit", accept));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
    return done.finally(() => clearTimeout(timer));
  });
  await Promise.all(pending);
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
try {
  await completion(
    start(python, ["-I", "apps/server-python/scripts/verify_environment.py", "--worker"]),
  );
  await completion(
    start(process.execPath, [
      "node_modules/turbo/bin/turbo",
      "run",
      "build",
      "--filter=@openbot/python-node-runtime",
      "--filter=@openbot/web^...",
    ]),
  );
  await completion(
    start(process.execPath, ["deploy/server/product-migrate.mjs"], {
      ...env,
      OPENBOT_DATABASE_URL: env.OPENBOT_CONTROL_DATABASE_URL,
    }),
  );
  if (stopping) throw new Error("Development startup interrupted.");
  const running = [completion(start(python, ["-I", "-B", "apps/server-python/scripts/serve.py"]))];
  if (!args.includes("--server-only"))
    running.push(
      completion(start(process.execPath, ["node_modules/vite/bin/vite.js", "apps/web"])),
    );
  await Promise.race(running);
} catch (error) {
  if (!stopping) {
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  await stop();
}
