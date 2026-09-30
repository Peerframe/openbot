import { execFile } from "node:child_process";
import { promisify } from "node:util";

export async function buildPostgresSupervisor(source: string, output: string): Promise<void> {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
    throw new Error("The PostgreSQL supervisor requires a native macOS build.");
  await promisify(execFile)(
    "/usr/bin/xcrun",
    [
      "clang",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-mmacosx-version-min=13.0",
      "-arch",
      process.arch === "arm64" ? "arm64" : "x86_64",
      source,
      "-o",
      output,
    ],
    { timeout: 60_000, maxBuffer: 16_384 },
  );
}
