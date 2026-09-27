import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertFreshSourceCheckout } from "./dev-startup-inputs.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "openbot-startup-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["apps/web", "packages/harness/dist", "providers"])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, "apps/web/package.json"), '{"name":"@openbot/web"}');
  await writeFile(
    join(root, "packages/harness/dist/openbot_agent_runtime-0.1.0-py3-none-any.whl"),
    "fixture",
  );
  return root;
}

test("fresh source accepts the required Python wheel and example configuration", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, ".env.example"), "");
  await writeFile(join(root, "apps/web/.env.example"), "");
  await assertFreshSourceCheckout(root);
});

test("a Python wheel does not exempt prebuilt app, shared package or provider JS", async (t) => {
  const root = await fixture(t);
  for (const path of ["apps/web", "packages/domain", "providers/coder"]) {
    await mkdir(join(root, path, "dist"), { recursive: true });
    await writeFile(join(root, path, "package.json"), "{}");
    await assert.rejects(assertFreshSourceCheckout(root), /prebuilt npm package/);
    await rm(join(root, path, "dist"), { recursive: true });
  }
  await assertFreshSourceCheckout(root);
});

test("root and Web local environment files still prevent synthetic startup", async (t) => {
  const root = await fixture(t);
  for (const path of [".env", ".env.local", "apps/web/.env", "apps/web/.env.production"]) {
    await writeFile(join(root, path), "");
    await assert.rejects(assertFreshSourceCheckout(root), /without local .env/);
    await rm(join(root, path));
  }
  await assertFreshSourceCheckout(root);
});
