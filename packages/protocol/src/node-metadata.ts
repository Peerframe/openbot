import { z } from "zod";

export const protocolVersion = "0.9.0" as const;

export const nodePlatformSchema = z.enum([
  "linux",
  "windows",
  "macos",
  "android",
  "ios",
  "freebsd",
  "unknown",
]);
export type NodePlatform = z.infer<typeof nodePlatformSchema>;

export const nodeArchitectureSchema = z.enum(["x64", "arm64", "armv7", "riscv64", "unknown"]);
export type NodeArchitecture = z.infer<typeof nodeArchitectureSchema>;

export const nodeCapabilitySchema = z.enum([
  "browser",
  "shell",
  "screenshot",
  "cua",
  "lume",
  "coder",
]);

export type NodeCapability = z.infer<typeof nodeCapabilitySchema>;

export const versionedCapabilityIdSchema = z.enum([
  "browser.session",
  "browser.page",
  "browser.observe",
  "browser.input",
  "screen.capture",
  "desktop.observe",
  "desktop.input",
  "shell.execute",
  "filesystem.read",
  "filesystem.write",
  "computer.takeover",
  "vm.manage",
  "code.execute",
]);
export type VersionedCapabilityId = z.infer<typeof versionedCapabilityIdSchema>;
