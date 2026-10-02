import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { runIconsTool } = require("app-builder-lib/out/toolsets/icons.js") as {
  runIconsTool(input: { inputFile: string; outputFormat: string; outDir: string }): Promise<void>;
};
export const ICON_SOURCES = ["app-icon.svg", "app-icon-dark.svg", "app-icon-small.svg"] as const;
export const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512] as const;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Artwork must be self-contained: rendering cannot fetch a resource or execute active SVG content.
export function validateIconSvg(svg: string): void {
  if (
    Buffer.byteLength(svg) > 1024 * 1024 ||
    !/<svg\b/u.test(svg) ||
    /<(?:script|foreignObject|image|text|style)\b|<!DOCTYPE|<!ENTITY|\bon\w+\s*=|@import|\b(?:href|xlink:href)\s*=|url\(\s*['"]?(?!#)/iu.test(
      svg,
    )
  ) {
    throw new Error(
      "Icon SVG must contain bounded, self-contained vector paths without fonts, scripts or external resources.",
    );
  }
  const match = /\bviewBox\s*=\s*["']([\d.\s+-]+)["']/u.exec(svg);
  const values = match?.[1]?.trim().split(/\s+/u).map(Number);
  if (
    !values ||
    values.length !== 4 ||
    !values.every(Number.isFinite) ||
    values[2] !== values[3] ||
    !(values[2]! > 0)
  )
    throw new Error("Icon SVG requires a square viewBox.");
}

export function mergeIcns(large: Buffer, small: Buffer): Buffer {
  const chunks = (input: Buffer) => {
    if (input.toString("ascii", 0, 4) !== "icns" || input.readUInt32BE(4) !== input.length)
      throw new Error("Invalid ICNS.");
    const frames = new Map<string, Buffer>();
    for (let pos = 8; pos < input.length; ) {
      const bytes = input.readUInt32BE(pos + 4);
      if (bytes < 8 || pos + bytes > input.length) throw new Error("Invalid ICNS frame.");
      frames.set(input.toString("ascii", pos, pos + 4), input.subarray(pos, pos + bytes));
      pos += bytes;
    }
    return frames;
  };
  const frames = chunks(large),
    micro = chunks(small);
  // Retina frames follow logical size: 16pt@2x and 32pt@2x also use the small drawing.
  for (const key of ["ic04", "ic05", "ic11", "ic12"]) {
    const frame = micro.get(key);
    if (!frame) throw new Error(`Missing small ICNS frame ${key}.`);
    frames.set(key, frame);
  }
  const header = Buffer.alloc(8);
  header.write("icns");
  const payload = Buffer.concat([...frames.values()]);
  header.writeUInt32BE(payload.length + 8, 4);
  return Buffer.concat([header, payload]);
}
export function mergeIco(large: Buffer, small: Buffer): Buffer {
  const frames = (input: Buffer) => {
    if (input.readUInt32LE(0) !== 65536) throw new Error("Invalid ICO.");
    return Array.from({ length: input.readUInt16LE(4) }, (_, i) => {
      const pos = 6 + i * 16,
        entry = Buffer.from(input.subarray(pos, pos + 16));
      const length = entry.readUInt32LE(8),
        offset = entry.readUInt32LE(12);
      if (offset + length > input.length) throw new Error("Invalid ICO frame.");
      return { size: entry[0] || 256, entry, payload: input.subarray(offset, offset + length) };
    });
  };
  const micro = frames(small),
    selected = frames(large).map((frame) =>
      frame.size <= 32 ? micro.find((item) => item.size === frame.size)! : frame,
    );
  if (selected.some((frame) => !frame)) throw new Error("Missing small ICO frame.");
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(selected.length, 4);
  let offset = 6 + selected.length * 16;
  for (const frame of selected) {
    frame.entry.writeUInt32LE(offset, 12);
    offset += frame.payload.length;
  }
  return Buffer.concat([
    header,
    ...selected.map((frame) => frame.entry),
    ...selected.map((frame) => frame.payload),
  ]);
}

function circularSvg(svg: string): string {
  const box = /\bviewBox\s*=\s*["']([^"']+)["']/u.exec(svg)![1]!;
  const [x, y, size] = box.trim().split(/\s+/u).map(Number) as [number, number, number];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}"><defs><clipPath id="linuxIconClip"><circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/></clipPath></defs><g clip-path="url(#linuxIconClip)">${svg.replace(/^[\s\S]*?<svg[^>]*>/u, "").replace(/<\/svg>\s*$/u, "")}</g></svg>`;
}

export async function preparePackageIcons(
  sourceDirectory = join(root, "docs/design/app-icon"),
  outputDirectory = join(root, "apps/desktop/out/icons"),
): Promise<boolean> {
  // Preserve the existing package until the artwork handoff begins. Once any source is present,
  // missing/invalid sources or conversion failures must never select the old binary artwork.
  const present = await Promise.all(
    [...ICON_SOURCES, "app-icon-linux.svg", "app-icon-splash.svg"].map(async (name) => {
      try {
        await lstat(join(sourceDirectory, name));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return false;
      }
    }),
  );
  if (!present.some(Boolean)) {
    console.warn("C16 SVG export pending: packaging with existing resources/openbot-icon assets; new icon acceptance remains pending.");
    return false;
  }
  await generateIcons(sourceDirectory, outputDirectory);
  return true;
}

export async function generateIcons(
  sourceDirectory = join(root, "docs/design/app-icon"),
  outputDirectory = join(root, "apps/desktop/out/icons"),
): Promise<void> {
  const sources: { name: string; content: string }[] = await Promise.all(
    ICON_SOURCES.map(async (name) => {
      let content: string;
      try {
        content = await readFile(join(sourceDirectory, name), "utf8");
      } catch {
        throw new Error(`C16 requires the approved SVG source: ${join(sourceDirectory, name)}`);
      }
      validateIconSvg(content);
      return { name, content };
    }),
  );
  const artwork = new Map(sources.map((source) => [source.name, source.content]));
  for (const name of ["app-icon-linux.svg", "app-icon-splash.svg"]) {
    try {
      const content = await readFile(join(sourceDirectory, name), "utf8");
      validateIconSvg(content);
      sources.push({ name, content });
      artwork.set(name, content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // Three master sources are sufficient; optional artboard-specific compositions override these.
  const linuxSource =
    artwork.get("app-icon-linux.svg") ?? circularSvg(artwork.get("app-icon.svg")!);
  const splashSource = artwork.get("app-icon-splash.svg") ?? artwork.get("app-icon-dark.svg")!;
  await mkdir(dirname(outputDirectory), { recursive: true });
  const staging = await mkdtemp(join(dirname(outputDirectory), ".icons-"));
  try {
    for (const source of sources) await writeFile(join(staging, source.name), source.content);
    const convert = async (name: string, format: string, label: string) => {
      const outDir = join(staging, label);
      await mkdir(outDir);
      await runIconsTool({ inputFile: join(staging, name), outputFormat: format, outDir });
      return outDir;
    };
    const largeIcns = await convert("app-icon.svg", "icns", "large-icns");
    const smallIcns = await convert("app-icon-small.svg", "icns", "small-icns");
    const largeIco = await convert("app-icon.svg", "ico", "large-ico");
    const smallIco = await convert("app-icon-small.svg", "ico", "small-ico");
    const result = join(staging, "result");
    await mkdir(join(result, "icons"), { recursive: true });
    await writeFile(
      join(result, "openbot-icon.icns"),
      mergeIcns(
        await readFile(join(largeIcns, "icon.icns")),
        await readFile(join(smallIcns, "icon.icns")),
      ),
    );
    await writeFile(
      join(result, "openbot-icon.ico"),
      mergeIco(
        await readFile(join(largeIco, "icon.ico")),
        await readFile(join(smallIco, "icon.ico")),
      ),
    );
    await writeFile(join(staging, "app-icon-linux.svg"), linuxSource);
    await writeFile(join(staging, "app-icon-splash.svg"), splashSource);
    const linux = await convert("app-icon-linux.svg", "set", "linux");
    // A circular clip preserves the micro drawing while using the approved Linux silhouette.
    const small = sources.find((source) => source.name === "app-icon-small.svg")!.content;
    await writeFile(join(staging, "linux-small.svg"), circularSvg(small));
    const microLinux = await convert("linux-small.svg", "set", "linux-micro");
    for (const size of PNG_SIZES)
      await copyFile(
        join(size <= 32 ? microLinux : linux, `${size}x${size}.png`),
        join(result, "icons", `${size}x${size}.png`),
      );
    const master = await convert("app-icon.svg", "set", "master-png");
    await copyFile(join(master, "512x512.png"), join(result, "openbot-icon.png"));
    await mkdir(join(result, "linux"));
    await copyFile(join(linux, "512x512.png"), join(result, "linux", "openbot-icon.png"));
    for (const [name, label] of [
      ["app-icon-dark.svg", "dark"],
      ["app-icon-splash.svg", "splash"],
    ]) {
      const set = await convert(name!, "icns", label!);
      const container = await readFile(join(set, "icon.icns"));
      let pos = 8;
      while (container.toString("ascii", pos, pos + 4) !== "ic10")
        pos += container.readUInt32BE(pos + 4);
      await writeFile(
        join(result, `openbot-icon-${label}.png`),
        container.subarray(pos + 8, pos + container.readUInt32BE(pos + 4)),
      );
    }
    await writeFile(
      join(result, "sources.json"),
      `${JSON.stringify({ tool: "electron-builder 26.16.1 / icons@1.2.3", linux: artwork.has("app-icon-linux.svg") ? "explicit" : "circular-master", splash: artwork.has("app-icon-splash.svg") ? "explicit" : "dark-icon-artwork-only", sources: sources.map(({ name, content }) => ({ name, sha256: createHash("sha256").update(content).digest("hex") })) }, null, 2)}\n`,
    );
    await rm(outputDirectory, { recursive: true, force: true });
    await rename(result, outputDirectory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await generateIcons();
