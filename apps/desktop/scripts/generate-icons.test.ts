import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generateIcons, ICON_SOURCES, PNG_SIZES, preparePackageIcons, validateIconSvg } from "./generate-icons.ts";

describe("C16 source-derived icon pipeline", () => {
  it("preserves baseline packaging only before any SVG handoff, never for a partial handoff", async () => {
    const temp = await mkdtemp(join(tmpdir(), "openbot-icons-absent-"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = join(temp, "stale-output");
      // A prior generated file must not select the new icon when the source export is absent.
      await writeFile(join(temp, "stale-output"), "stale");
      expect(await preparePackageIcons(join(temp, "not-exported"), out)).toBe(false);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("existing resources/openbot-icon"));
      await expect(generateIcons(temp, out)).rejects.toThrow("C16 requires the approved SVG source");
      for (const name of [...ICON_SOURCES, "app-icon-linux.svg", "app-icon-splash.svg"]) {
        await writeFile(join(temp, name), '<svg viewBox="0 0 128 128"/>');
        await expect(preparePackageIcons(temp, out)).rejects.toThrow("C16 requires the approved SVG source");
        await rm(join(temp, name));
      }
      expect(await readFile(out, "utf8")).toBe("stale");
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
      await rm(temp, { recursive: true, force: true });
    }
  });
  it("rejects active/external artwork and non-square sources", () => {
    for (const body of [
      '<image href="https://example.test/a"/>',
      "<script/>",
      "<text>x</text>",
      '<path onclick="x()"/>',
      '<path fill="url(https://example.test/a)"/>',
      "<foreignObject/>",
    ])
      expect(() => validateIconSvg(`<svg viewBox="0 0 128 128">${body}</svg>`)).toThrow();
    expect(() => validateIconSvg('<svg viewBox="0 0 128 64"/>')).toThrow();
  });
  it("converts synthetic vectors twice identically and preserves output when a source is missing", async () => {
    const temp = await mkdtemp(join(tmpdir(), "openbot-icons-"));
    try {
      for (const name of ICON_SOURCES)
        await writeFile(
          join(temp, name),
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="${name.includes("small") ? "#00ff00" : "#ff0000"}"/></svg>`,
        );
      const out = join(temp, "result");
      expect(await preparePackageIcons(temp, out)).toBe(true);
      const names = [
        "openbot-icon.icns",
        "openbot-icon.ico",
        "openbot-icon.png",
        "linux/openbot-icon.png",
        "openbot-icon-dark.png",
        "openbot-icon-splash.png",
        "sources.json",
        ...PNG_SIZES.map((size) => `icons/${size}x${size}.png`),
      ];
      const first = await Promise.all(names.map((name) => readFile(join(out, name))));
      await generateIcons(temp, out);
      for (const [i, name] of names.entries())
        expect(await readFile(join(out, name))).toEqual(first[i]);
      expect(await readFile(join(out, "openbot-icon.png"))).not.toEqual(
        await readFile(join(out, "linux/openbot-icon.png")),
      );
      const ico = await readFile(join(out, "openbot-icon.ico"));
      expect(ico.readUInt16LE(4)).toBe(7);
      const icns = await readFile(join(out, "openbot-icon.icns"));
      expect(icns.toString("ascii", 0, 4)).toBe("icns");
      expect(icns.readUInt32BE(4)).toBe(icns.length);
      const original = await readFile(join(temp, "app-icon.svg"), "utf8");
      await writeFile(join(temp, "app-icon.svg"), '<svg viewBox="0 0 128 128"><script/></svg>');
      await expect(preparePackageIcons(temp, out)).rejects.toThrow("self-contained");
      expect(await readFile(join(out, "openbot-icon.ico"))).toEqual(ico);
      await writeFile(join(temp, "app-icon.svg"), original);
      for (const size of PNG_SIZES) {
        const png = await readFile(join(out, "icons", `${size}x${size}.png`));
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
      }
      await rm(join(temp, "app-icon.svg"));
      await expect(generateIcons(temp, out)).rejects.toThrow(
        "C16 requires the approved SVG source",
      );
      expect(await readFile(join(out, "openbot-icon.ico"))).toEqual(ico);
      expect((await readdir(temp)).filter((name) => name.startsWith(".icons-"))).toEqual([]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }, 60000);
});
