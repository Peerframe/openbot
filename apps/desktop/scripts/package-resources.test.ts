import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyContainedResource, validateContainedResource } from "./package-resources.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openbot-resource-copy-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "packages", "config"), { recursive: true });
  await mkdir(join(source, "node_modules", "@openbot"), { recursive: true });
  await writeFile(join(source, "packages", "config", "index.js"), "export const value = 1;");
  return { root, source, destination: join(root, "destination") };
}

describe("packaged native resource portability", () => {
  it.skipIf(process.platform === "win32")(
    "keeps internal links working after moving the app and removing its build tree",
    async () => {
      const { root, source, destination } = await fixture();
      await symlink("../../packages/config", join(source, "node_modules", "@openbot", "config"));
      await copyContainedResource(source, destination);
      await rm(source, { recursive: true });
      const moved = join(root, "moved-app");
      await rename(destination, moved);
      expect(await readlink(join(moved, "node_modules", "@openbot", "config"))).toBe(
        "../../packages/config",
      );
      expect(
        await readFile(join(moved, "node_modules", "@openbot", "config", "index.js"), "utf8"),
      ).toBe("export const value = 1;");
      await expect(validateContainedResource(moved)).resolves.toBeUndefined();
    },
  );

  it
    .skipIf(process.platform === "win32")
    .each(["absolute", "external", "broken", "cyclic"] as const)(
    "rejects %s symlinks before creating a destination",
    async (kind) => {
      const { root, source, destination } = await fixture();
      await writeFile(join(root, "outside.txt"), "outside");
      const target = {
        absolute: join(source, "packages", "config"),
        external: "../outside.txt",
        broken: "missing",
        cyclic: "link",
      }[kind];
      await symlink(target, join(source, "link"));
      await expect(copyContainedResource(source, destination)).rejects.toThrow();
      await expect(
        readFile(join(destination, "packages", "config", "index.js")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects a nested destination and preserves an existing artifact", async () => {
    const { source, destination } = await fixture();
    await expect(copyContainedResource(source, join(source, "nested"))).rejects.toThrow(/outside/u);
    await copyContainedResource(source, destination);
    await writeFile(join(destination, "packages", "config", "index.js"), "existing artifact");
    await expect(copyContainedResource(source, destination)).rejects.toThrow();
    expect(await readFile(join(destination, "packages", "config", "index.js"), "utf8")).toBe(
      "existing artifact",
    );
  });
});
