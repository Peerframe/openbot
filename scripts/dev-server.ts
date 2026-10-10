/** Builds cold prerequisites, then starts the sole Server and optional Web development process. */
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DevProcessOwner } from "./dev-processes.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--server-only"))
  throw new Error("Only --server-only is supported.");
const base = process.env;
if (!base.OPENBOT_TS_DATABASE_URL || !base.OPENBOT_TS_OWNER_PASSWORD || !base.OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH)
  throw new Error("Set OPENBOT_TS_DATABASE_URL, OPENBOT_TS_OWNER_PASSWORD and OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH; see .env.example.");
const privateDirectory = async (value: string) => {
  const path = resolve(root, value);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
};
const objects = await privateDirectory(base.OPENBOT_TS_OBJECT_ROOT ?? "data/product/objects");
const artifacts = await privateDirectory(base.OPENBOT_TS_ARTIFACT_ROOT ?? "data/product/artifacts");
const origin = base.OPENBOT_TS_PUBLIC_ORIGIN ?? "http://127.0.0.1:3001";
const origins = `${origin},http://localhost:5173,http://127.0.0.1:5173`;
const env = { ...base, OPENBOT_DEV_API_URL: origin,
  OPENBOT_TS_HOST: "127.0.0.1", OPENBOT_TS_PORT: "3001", OPENBOT_TS_PUBLIC_ORIGIN: origin,
  OPENBOT_TS_AUTH_ALLOWED_ORIGINS: base.OPENBOT_TS_AUTH_ALLOWED_ORIGINS ?? origins,
  OPENBOT_TS_READ_ALLOWED_ORIGINS: base.OPENBOT_TS_READ_ALLOWED_ORIGINS ?? origins,
  OPENBOT_TS_WRITE_ALLOWED_ORIGINS: base.OPENBOT_TS_WRITE_ALLOWED_ORIGINS ?? origins,
  OPENBOT_TS_OBJECT_ROOT: objects, OPENBOT_TS_ARTIFACT_ROOT: artifacts, OPENBOT_TS_WORK_FILE_ROOT: artifacts,
  OPENBOT_TS_MODEL_CONNECTION_KEY_PATH: base.OPENBOT_TS_MODEL_CONNECTION_KEY_PATH ?? resolve(objects, "model-connections.key"),
};
const owner = new DevProcessOwner({ cwd: root, graceMs: 12000 });
const stop = () => { void owner.stop().catch(() => { process.exitCode = 1; }); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
try {
  await owner.waitSuccess(owner.start(process.execPath,
    ["node_modules/turbo/bin/turbo", "run", "build", "--filter=@openbot/server", "--filter=@openbot/web^..."], env));
  if (!owner.stopping) {
    const running = [owner.waitSuccess(owner.start(process.execPath, ["deploy/server/product-entry.ts"], env))];
    if (!args.includes("--server-only")) running.push(owner.waitSuccess(owner.start(process.execPath, ["scripts/dev-web.ts"], env)));
    await Promise.race(running);
  }
} catch {
  if (!owner.stopping) { console.error("Development startup failed; see the owned process diagnostic."); process.exitCode = 1; }
} finally {
  await owner.stop(); process.off("SIGTERM", stop); process.off("SIGINT", stop);
}
