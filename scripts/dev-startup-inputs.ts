import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function assertFreshSourceCheckout(root: string): Promise<void> {
  for (const directory of [root, join(root, "apps/web")]) {
    const files = await readdir(directory);
    assert(
      !files.some(
        (name) => name === ".env" || (name.startsWith(".env.") && name !== ".env.example"),
      ),
      "Use a fresh checkout without local .env files; this check supplies its own configuration.",
    );
  }
  for (const group of ["apps", "packages", "providers"]) {
    for (const name of await readdir(join(root, group))) {
      const directory = join(root, group, name);
      // Installing the Python wheel is a startup prerequisite. Only npm package
      // builds can mask a missing shared JS build in the source-startup journey.
      if (!existsSync(join(directory, "package.json"))) continue;
      assert(
        !existsSync(join(directory, "dist")),
        `Run dev:smoke before build/test/check; prebuilt npm package: ${group}/${name}/dist.`,
      );
    }
  }
}
