/** Root-owned native packet pins. The wire cannot select executables, source, images or paths. */
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { commandValue } from "../../apps/server/dist/work-command-values.js";
import { digest, directory, requireFact, Refused } from "./protected-io.ts";
import { command } from "./native-unit.ts";
export const reviewedBinaryHashes = {
  containerd: "8260dd2b405520c10d44f1b75ace6b58e2579d10113cadc6d6b8df533ff68f6e",
  "containerd-shim-runsc-v1": "4b0c2a8eb7414d8b5f3d032e158784b454e9c98ffa3fdebbdd79047faf930d7c",
  docker: "9c46230f41e4263b3a9d93ae9284722709923c50d138bc64eed2bb6c02af0581",
  dockerd: "809c45f959337b17be8b413d96fdcaad826393eef643b4e476a5df918d25a162",
  "gvisor-bin/checkpointgofer": "e29be2ab32a10eb885c4a46635f47b80ad661be6f23b5d7903f11906941c7aab",
  "gvisor-bin/gvisor-sentry-prewarmer":
    "3315d7ad7c2d3751d349e4976fa02da1da6fd7e41746c35622304e5fabe4fce0",
  "gvisor-bin/gvisor_sentry": "aff3ed7dfac54b04aab14de2dde53e021402f0ba238bc7ece3ac7d4b6604b055",
  "gvisor-bin/runsc-fd-parking": "03af90d07ea466c10ecc3e3ba839b2a59540959dd3286aea3886917cba850c11",
  "gvisor-bin/runsc-metric-server":
    "02bb563cd060fe7992ccd00927024b02b70e0803b61abfa015e158d9d7e88507",
  runsc: "c0f4ec0ac1198975d5cf919a78f2302426de096f69eebd33e50125c3ca42d699",
};
export const reviewedImage =
  "python@sha256:6e13e65c55e33adf203d77ee371cf8bf5d81bd4902ef07565721f46bf44917af";
export type NativeConfiguration = {
  base: string;
  binaries: string;
  archive: string;
  archiveSha256: string;
  image: string;
  imageTag: string;
  helper: string;
  helperSha256: string;
  node: string;
  nodeSha256: string;
  binaryHashes: typeof reviewedBinaryHashes;
  secretsDirectory: string;
};
export const hashValue = (value: unknown) =>
  createHash("sha256").update(commandValue(value, 32768)).digest("hex");
export function nativeEnvironment(config: NativeConfiguration) {
  return { LANG: "C", LC_ALL: "C", PATH: config.binaries + ":/usr/sbin:/usr/bin:/sbin:/bin" };
}
export function trustedFile(path: string, expected?: string) {
  requireFact(isAbsolute(path) && realpathSync(path) === path, "native_file_alias");
  directory(dirname(path), 0, false);
  const value = lstatSync(path);
  if (!value.isFile() || value.nlink !== 1 || value.uid !== 0 || value.mode & 0o022)
    throw new Refused("unsafe_native_file", {
      cause: {
        file: basename(path),
        regular: value.isFile(),
        links: value.nlink,
        uid: value.uid,
        mode: value.mode & 0o7777,
      },
    });
  if (expected)
    requireFact(
      /^[a-f0-9]{64}$/.test(expected) && digest(path) === expected,
      "native_file_changed",
    );
  return path;
}
export function validateNativeConfiguration(config: NativeConfiguration) {
  requireFact(
    process.platform === "linux" && process.arch === "x64" && process.geteuid?.() === 0,
    "qualified_linux_root_required",
  );
  const keys = [
    "base",
    "binaries",
    "archive",
    "archiveSha256",
    "image",
    "imageTag",
    "helper",
    "helperSha256",
    "node",
    "nodeSha256",
    "binaryHashes",
    "secretsDirectory",
  ].sort();
  requireFact(config && same(Object.keys(config).sort(), keys), "invalid_native_config");
  for (const k of ["base", "binaries", "secretsDirectory"] as const) directory(config[k]);
  requireFact(
    same(config.binaryHashes, reviewedBinaryHashes) && config.image === reviewedImage,
    "missing_native_pin",
  );
  requireFact(/^python:[A-Za-z0-9._-]+$/.test(config.imageTag), "image_tag_changed");
  // Quotes/newlines cannot be introduced into the fixed TOML or systemd path properties.
  for (const value of [
    config.base,
    config.binaries,
    config.archive,
    config.helper,
    config.node,
    config.secretsDirectory,
  ])
    requireFact(/^\/[A-Za-z0-9_./-]+$/.test(value), "unsafe_native_path");
  for (const [file, pin] of Object.entries(config.binaryHashes))
    trustedFile(join(config.binaries, file), pin);
  trustedFile(config.archive, config.archiveSha256);
  trustedFile(config.helper, config.helperSha256);
  trustedFile(config.node, config.nodeSha256);
  for (const path of [
    "/usr/bin/nsenter",
    "/usr/bin/systemctl",
    "/usr/bin/systemd-run",
    "/usr/bin/busctl",
    "/usr/bin/mount",
    "/usr/sbin/losetup",
    "/usr/sbin/mkfs.ext4",
  ])
    trustedFile(realpathSync(path));
}
export async function qualifyNativeTools(config: NativeConfiguration) {
  const run = command(nativeEnvironment(config));
  requireFact(
    (await run(["/usr/bin/systemctl", "--version"])).split("\n")[0]?.startsWith("systemd 255"),
    "systemd_version_changed",
  );
  requireFact(
    (await run(["/usr/bin/nsenter", "--version"])) === "nsenter from util-linux 2.39.3",
    "nsenter_version_changed",
  );
  requireFact(
    ["v22.22.2", "v24.21.0"].includes(await run([config.node, "--version"])),
    "node_version_changed",
  );
}
