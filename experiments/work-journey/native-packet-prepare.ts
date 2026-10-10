/** Prepares reviewed disposable Ubuntu native inputs; no host daemon, personal trust or product data. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  reviewedBinaryHashes,
  reviewedImage,
  reviewedImageConfig,
} from "../linux-execution/native-config.ts";
import { command, type NativeCommand } from "../linux-execution/native-unit.ts";
import { digest, directory } from "../linux-execution/protected-io.ts";
import { ociIdentity, pinnedNativeMembers } from "./native-packet-archives.ts";
import { prepareNativeTls } from "./native-packet-tls.ts";
import { patchListener, verifyBrowserUpstream } from "./product-browser-upstream.ts";
export const BASE = "/opt/obp4",
  PACKET = BASE + "/composition-20260926-a1";
export const nativeDownloads = {
  docker: {
    url: "https://download.docker.com/linux/static/stable/x86_64/docker-29.8.1.tgz",
    sha256: "d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70",
    size: 86055881,
  },
  gvisor: {
    url: "https://github.com/google/gvisor/releases/download/release-20260914.0/gvisor-x86_64.tar.bz2",
    sha256: "94a1b9716797efcb0b348fc3283ddaa1ee5c7898b61eeccb08ee9ac7dc903c15",
    size: 166025232,
  },
  nss: {
    url: "https://archive.ubuntu.com/ubuntu/pool/main/n/nss/libnss3-tools_3.98-1build1_amd64.deb",
    sha256: "d8d6093edcf2206edeee40eaddd90a54bacc84cde4d8cc9c4fb50bd7aa12cf0d",
    size: 615188,
  },
};
const CHROMIUM_IMAGE =
    "mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e",
  CHROMIUM_CONFIG = "sha256:fee853fafa59550d162cef52bca02d907694b44ebf6ef9fb075bcc0c65d8dedb";
export const SQUID_TAG = "openbot-squid77-debian-fixture:20260926";
const environment = {
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
  HOME: "/root",
  DOCKER_BUILDKIT: "1",
};
const run = command(environment);
export const packetCaptureBytes = 2 * 1024 * 1024;

const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
};
const record = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
/** Seal only fresh packet copies; libuv copyFile preserves the source owner's UID/GID. */
export async function sealPacketFile(path: string, mode = 0o600) {
  assert.equal(process.geteuid?.(), 0, "Root-owned packet sealing required");
  assert(mode === 0o600 || mode === 0o644, "Fixed packet file mode required");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    assert(before.isFile() && before.nlink === 1, "Single regular packet copy required");
    await file.chown(0, 0);
    await file.chmod(mode);
    const after = await file.stat();
    assert(
      after.ino === before.ino &&
        after.dev === before.dev &&
        after.uid === 0 &&
        after.gid === 0 &&
        after.nlink === 1 &&
        (after.mode & 0o777) === mode,
      "Packet copy sealing failed",
    );
  } finally {
    await file.close();
  }
}
async function copy(source: string, target: string) {
  await mkdir(dirname(target), { mode: 0o700, recursive: true });
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await sealPacketFile(target);
}
export function replaceExact(text: string, old: string, replacement: string) {
  const at = text.indexOf(old);
  assert(at >= 0 && text.indexOf(old, at + old.length) === -1, "Reviewed source shape changed");
  return text.slice(0, at) + replacement + text.slice(at + old.length);
}
export async function downloadNative(
  target: string,
  pin: { url: string; sha256: string; size: number },
  fetcher: typeof fetch = fetch,
) {
  assert(new URL(pin.url).protocol === "https:", "TLS download required");
  const output = await open(target, "wx", 0o600);
  let body: ReadableStream<Uint8Array> | null = null;
  try {
    const response = await fetcher(pin.url, { signal: AbortSignal.timeout(120000) });
    body = response.body;
    assert(response.ok && body, "Native download refused");
    const hash = createHash("sha256");
    let count = 0;
    for await (const part of body) {
      count += part.length;
      assert(count <= pin.size, "Native download exceeded");
      hash.update(part);
      await output.writeFile(part);
    }
    assert.equal(count, pin.size, "Native download size changed");
    assert.equal(hash.digest("hex"), pin.sha256, "Native download pin changed");
  } finally {
    if (body && !body.locked) await body.cancel().catch(() => {});
    await output.close();
  }
}
export function exportArguments(image: string, path: string, manifest?: string, daemon = false) {
  const tag = image.split("@")[0]!,
    pin = image.split("@")[1] ?? manifest;
  // A registry port is not an image tag; a digest-only reference has no tag to remove.
  const colon = tag.lastIndexOf(":"),
    slash = tag.lastIndexOf("/");
  const repository = colon > slash ? tag.slice(0, colon) : tag;
  const immutable = pin ? repository + "@" + pin : image;
  return [
    "/usr/bin/skopeo",
    "--override-os",
    "linux",
    "--override-arch",
    "amd64",
    "copy",
    "--src-no-creds",
    "--src-tls-verify=true",
    ...(daemon ? ["--dest-oci-accept-uncompressed-layers"] : ["--preserve-digests"]),
    daemon ? "docker-daemon:" + image : "docker://" + immutable,
    "oci-archive:" + path + (daemon ? ":" + image : ""),
  ];
}
async function exportImage(
  image: string,
  path: string,
  config?: string,
  manifest?: string,
  daemon = false,
) {
  assert(!present(path), "Fresh OCI archive required");
  await run(exportArguments(image, path, manifest, daemon), 600000, packetCaptureBytes);
  await chmod(path, 0o600);
  return {
    image,
    ...(await ociIdentity(path, config, manifest)),
    archiveSha256: digest(path),
    archiveBytes: (await lstat(path)).size,
  };
}
export async function browserTrust(packet: string, certutil: string, invoke: NativeCommand = run) {
  const trust = join(packet, "nssdb");
  await mkdir(trust, { mode: 0o755 });
  await invoke([certutil, "-N", "-d", "sql:" + trust, "--empty-password"], 20000);
  await invoke(
    [
      certutil,
      "-A",
      "-d",
      "sql:" + trust,
      "-n",
      "OpenBot disposable fixture CA",
      "-t",
      "C,,",
      "-i",
      join(packet, "tls/ca.pem"),
    ],
    20000,
  );
  // This public CA is generated by the current fixture owner, unlike imported runner files.
  await copyFile(join(packet, "tls/ca.pem"), join(trust, "ca.pem"), constants.COPYFILE_EXCL);
  await chmod(trust, 0o755);
  for (const name of await readdir(trust)) {
    const file = join(trust, name);
    assert((await lstat(file)).isFile(), "Unexpected NSS entry");
    await chmod(file, 0o644);
  }
}
export async function packetFiles(root: string) {
  root = realpathSync(root);
  const records: { path: string; bytes: number; sha256: string }[] = [];
  async function visit(path: string) {
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name),
        info = await lstat(file);
      if (info.isSymbolicLink()) {
        const target = relative(root, realpathSync(file));
        assert(
          target && target !== ".." && !target.startsWith(".." + sep) && !isAbsolute(target),
          "External packet symlink",
        );
      } else if (info.isDirectory()) await visit(file);
      else {
        assert(info.isFile(), "Nonregular packet input");
        records.push({ path: relative(root, file), bytes: info.size, sha256: digest(file) });
      }
    }
  }
  await visit(root);
  return records;
}
async function sealParent() {
  const before = await lstat("/opt");
  assert(before.isDirectory() && !before.isSymbolicLink());
  await chown("/opt", 0, 0);
  await chmod("/opt", 0o755);
  const after = await lstat("/opt");
  assert(
    after.isDirectory() &&
      before.ino === after.ino &&
      before.dev === after.dev &&
      after.uid === 0 &&
      after.gid === 0 &&
      (after.mode & 0o7777) === 0o755,
    "Fixture parent changed",
  );
  const value = (v: typeof before) => ({
    uid: v.uid,
    gid: v.gid,
    mode: "0o" + (v.mode & 0o7777).toString(8),
  });
  return { path: "/opt", before: value(before), after: value(after), inodeUnchanged: true };
}
export async function prepareNativePacket(
  repository: string,
  upstream: string,
  bun: string,
  node: string,
  launcher: string,
  nativeRuntime: string,
  modules: string,
) {
  assert(
    process.platform === "linux" &&
      process.arch === "x64" &&
      process.geteuid?.() === 0 &&
      process.env.GITHUB_ACTIONS === "true",
    "Disposable Linux CI only",
  );
  assert(
    (await readFile("/etc/os-release", "utf8")).includes('VERSION_ID="24.04"'),
    "Ubuntu 24.04 required",
  );
  assert(!present(BASE), "Fresh native packet required");
  const fixtureParent = await sealParent();
  process.umask(0o077);
  await mkdir(BASE, { mode: 0o700 });
  for (const path of ["bin", "bin/gvisor-bin", "downloads", "units"])
    await mkdir(join(BASE, path), { mode: 0o700 });
  await mkdir(PACKET, { mode: 0o700 });
  directory(BASE);
  const browser = join(repository, "experiments/browser-execution");
  await verifyBrowserUpstream(upstream);
  assert.equal(
    digest(join(browser, "seccomp_profile.json")),
    "d00ad84f5a67031fe2bb64de8d77a5ad9c06adb82935ebdb3c18b5f7ba60a5d0",
    "Reviewed seccomp changed",
  );
  assert.equal(await run([bun, "--version"]), "1.3.14");
  assert.equal(await run([node, "--version"]), "v22.22.2");
  for (const [name, version] of [
    ["skopeo", "1.13.3+ds1-2ubuntu0.24.04.3"],
    ["bzip2", "1.0.8-5.1ubuntu0.1"],
  ])
    assert.equal(
      await run(["/usr/bin/dpkg-query", "-W", "-f=${Version}", name!]),
      version,
      "Reviewed distribution tool changed",
    );
  for (const [name, filename] of [
    ["docker", "docker.tgz"],
    ["gvisor", "gvisor.tar.bz2"],
    ["nss", "nss.deb"],
  ] as const)
    await downloadNative(join(BASE, "downloads", filename), nativeDownloads[name]);
  const allBinaries = {
    ...reviewedBinaryHashes,
    "containerd-shim-runc-v2": "60a23e7d1d8f60b2f7ae8046cd656066c9dea065c3e0da3ce61cf2fdf173afd3",
    "docker-init": "5ccb076690ac3d060511c63d02194bd5cefaba8dbf225fd60b26283eb1055e4b",
  };
  for (const [name, filename, prefix, compression] of [
    ["docker", "docker.tgz", "docker/", "gzip"],
    ["gvisor", "gvisor.tar.bz2", "", "bzip2"],
  ] as const) {
    const expected = Object.fromEntries(
      Object.entries(allBinaries).filter(
        ([key]) =>
          (key === "runsc" ||
            key === "containerd-shim-runsc-v1" ||
            key.startsWith("gvisor-bin/")) ===
          (name === "gvisor"),
      ),
    );
    for (const [file, bytes] of await pinnedNativeMembers(
      join(BASE, "downloads", filename),
      nativeDownloads[name],
      expected,
      prefix,
      compression,
    ))
      await writeFile(join(BASE, "bin", file), bytes, { flag: "wx", mode: 0o755 });
  }
  for (const [file, pin] of Object.entries(allBinaries)) {
    await chmod(join(BASE, "bin", file), 0o755);
    assert.equal(digest(join(BASE, "bin", file)), pin);
  }
  const command = await exportImage(
    reviewedImage,
    join(BASE, "downloads/command-node-amd64.tar"),
    reviewedImageConfig,
    reviewedImage.split("@")[1],
  );
  const chromium = await exportImage(
    CHROMIUM_IMAGE,
    join(BASE, "downloads/playwright-1.62.1-linux-amd64.tar"),
    CHROMIUM_CONFIG,
    "sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
  );
  await run(
    [
      "/usr/bin/docker",
      "build",
      "--platform",
      "linux/amd64",
      "--tag",
      SQUID_TAG,
      "--file",
      join(browser, "egress-fixture.Dockerfile"),
      browser,
    ],
    600000,
    packetCaptureBytes,
  );
  const squid = await exportImage(
    SQUID_TAG,
    join(PACKET, "squid-image.tar"),
    undefined,
    undefined,
    true,
  );
  // All root browser executables are sealed TS bundles. The sandbox OS image remains pinned.
  await copy(launcher, join(BASE, "browser-launcher.cjs"));
  await copy(nativeRuntime, join(BASE, "browser-native.cjs"));
  assert.equal(JSON.parse(await readFile(join(modules, "package.json"), "utf8")).version, "3.3.2");
  await mkdir(join(BASE, "node_modules"), { mode: 0o700 });
  for (const [source, target] of [
    [modules, "koffi"],
    [join(dirname(modules), "@koromix/koffi-linux-x64"), "@koromix/koffi-linux-x64"],
  ] as const) {
    const destination = join(BASE, "node_modules", target);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(source, destination, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    for (const entry of await packetFiles(destination))
      await sealPacketFile(join(destination, entry.path));
  }
  const browserModules = await packetFiles(join(BASE, "node_modules"));
  await copy(node, join(BASE, "node"));
  await chmod(join(BASE, "node"), 0o755);
  await cp(upstream, join(PACKET, "api"), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  });
  const index = join(PACKET, "api/src/index.ts");
  await writeFile(index, patchListener(await readFile(index), true));
  for (const entry of await packetFiles(join(PACKET, "api")))
    await sealPacketFile(join(PACKET, "api", entry.path), 0o644);
  async function directories(path: string): Promise<void> {
    await chmod(path, 0o755);
    for (const name of await readdir(path)) {
      const file = join(path, name);
      if ((await lstat(file)).isDirectory()) await directories(file);
    }
  }
  await directories(join(PACKET, "api"));
  await copy(bun, join(PACKET, "bun"));
  await chmod(join(PACKET, "bun"), 0o755);
  for (const name of ["socket_probe.mjs", "tunnel_probe.mjs", "browser-entry.mjs", "fixture.nft"])
    await copy(join(browser, "composition", name), join(PACKET, name));
  await copy(join(browser, "seccomp_profile.json"), join(PACKET, "seccomp_profile.json"));
  const identity = "deadline-a1-p4" + randomBytes(3).toString("hex"),
    program = join(BASE, "browser-native.cjs");
  await prepareNativeTls(join(PACKET, "tls"));
  const nss = join(BASE, "nss-tools");
  await run(["/usr/bin/dpkg-deb", "--extract", join(BASE, "downloads/nss.deb"), nss], 20000);
  await browserTrust(PACKET, join(nss, "usr/bin/certutil"));
  for (const name of ["socket_probe.mjs", "tunnel_probe.mjs", "browser-entry.mjs"])
    await chmod(join(PACKET, name), 0o644);
  await record(join(PACKET, "FILES.json"), await packetFiles(PACKET));
  const plan = {
    version: 1,
    fixtureEnvironment: "disposable-github-linux",
    fixtureParent,
    nativeRoot: join(BASE, "units", identity),
    browserProgram: program,
    browserProgramSha256: digest(program),
    browserModules,
    packet: PACKET,
    reviewedBinaries: reviewedBinaryHashes,
    command,
    chromium,
    squid,
    bunSha256: digest(bun),
    browserLauncherSha256: digest(join(BASE, "browser-launcher.cjs")),
    browserNodeSha256: digest(join(BASE, "node")),
    packagingAdaptations: [
      "root-owned /opt ancestor on disposable runner",
      "fresh native root",
      "offline export hash bound to reviewed image config/layers",
      "exact Squid manifest tagged only inside private daemon",
      "root-private Node, Koffi and TS browser bundles",
      "Bun 1.3.14 from existing CI",
      "original browser listener only inside private network",
      "new synthetic TLS CA/NSS database",
      "TS packet and browser composition without Python launchers/control/harness/venv/wheel",
    ],
  };
  await record(join(BASE, "PLAN.json"), plan);
  return {
    nativePacketReady: true,
    fixtureEnvironment: plan.fixtureEnvironment,
    rootFresh: true,
    imageContentPinned: true,
    binariesPinned: true,
    fixtureParent,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    assert(
      key &&
        [
          "--repository",
          "--upstream",
          "--bun",
          "--node",
          "--launcher",
          "--native",
          "--koffi",
        ].includes(key) &&
        value &&
        !values[key],
    );
    values[key] = realpathSync(value);
  }
  assert.equal(Object.keys(values).length, 7, "Explicit native packet inputs required");
  assert.equal(
    values["--repository"],
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    "Repository identity changed",
  );
  console.log(
    JSON.stringify(
      await prepareNativePacket(
        values["--repository"]!,
        values["--upstream"]!,
        values["--bun"]!,
        values["--node"]!,
        values["--launcher"]!,
        values["--native"]!,
        values["--koffi"]!,
      ),
    ),
  );
}
