import {
  closeSync,
  constants,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { mkdirAt, openAt, openDirectory, unlinkAt } from "./posix-files.js";
import { directoryNames, removeDirectoryAt, renameAt } from "./posix-directory.js";

it.skipIf(!["darwin", "linux"].includes(process.platform))(
  "enumerates and stages by descriptor through path replacement without following links",
  () => {
    const base = mkdtempSync(join(realpathSync(tmpdir()), "openbot-dir-"));
    const fd = openDirectory(join(base, "store"), true);
    try {
      writeFileSync(join(base, "store", "中文.json"), "data");
      expect(directoryNames(fd)).toEqual(["中文.json"]);
      expect(directoryNames(fd)).toEqual(["中文.json"]);
      renameSync(join(base, "store"), join(base, "old"));
      symlinkSync(base, join(base, "store"));
      expect(directoryNames(fd)).toEqual(["中文.json"]);
      mkdirAt(fd, ".journal");
      const journal = openAt(fd, ".journal", constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        renameAt(fd, "中文.json", journal, "file.json");
        expect(directoryNames(journal)).toEqual(["file.json"]);
        expect(readFileSync(join(base, "old", ".journal", "file.json"), "utf8")).toBe("data");
        expect(() => directoryNames(journal, 0)).toThrow("limit");
        expect(() => renameAt(fd, "../escape", journal, "other")).toThrow();
        unlinkAt(journal, "file.json");
      } finally {
        closeSync(journal);
      }
      removeDirectoryAt(fd, ".journal");
      expect(directoryNames(fd)).toEqual([]);
    } finally {
      closeSync(fd);
      rmSync(base, { recursive: true, force: true });
    }
  },
);
