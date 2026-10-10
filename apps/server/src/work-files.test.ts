import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkFiles } from "./work-files.js";
import { sha256 } from "./work-values.js";

it("round-trips empty and binary artifacts; existing corrupt and linked blobs cannot be replaced", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openbot-work-files-")));
  try {
    const files = new WorkFiles(root);
    files.verify();
    for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 32, 12])]) {
      const blob = files.put(bytes);
      expect(files.read(blob)).toEqual(bytes);
      expect(files.put(bytes)).toEqual(blob);
    }
    const original = Buffer.from("expected"),
      digest = sha256(original);
    await writeFile(join(root, digest), "corrupt!", { mode: 0o600 });
    expect(() => files.put(original)).toThrow();
    await rm(join(root, digest));
    await symlink("missing", join(root, digest));
    expect(() => files.put(original)).toThrow();
    await chmod(root, 0o755);
    expect(() => files.verify()).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
