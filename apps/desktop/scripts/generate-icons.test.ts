import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateIcons, ICON_SOURCES, PNG_SIZES, validateIconSvg } from "./generate-icons.ts";

describe("C16 source-derived icon pipeline", () => {
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
      await generateIcons(temp, out);
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
