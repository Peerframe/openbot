import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./install-desktop.sh", import.meta.url));

test("bootstrap defaults match the Desktop version and Windows keeps OS trust policy", async () => {
  const manifest: unknown = JSON.parse(
    await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
  );
  assert.ok(
    typeof manifest === "object" &&
      manifest !== null &&
      "version" in manifest &&
      typeof manifest.version === "string",
    "Desktop package version is required.",
  );
  const shell = await readFile(script, "utf8");
  const powershell = await readFile(new URL("./install-desktop.ps1", import.meta.url), "utf8");
  assert.ok(shell.includes(`version="\${1:-${manifest.version}}"`));
  assert.ok(powershell.includes(`[string]$Version = "${manifest.version}"`));
  assert.ok(powershell.includes("Get-FileHash -Algorithm SHA256"));
  assert.ok(powershell.includes("Zone.Identifier"));
  assert.doesNotMatch(powershell, /Unblock-File|ExecutionPolicy\s+Bypass|Verb\s+RunAs/i);
});

test("shell bootstrap rejects malformed release references before invoking curl", {
  skip: process.platform === "win32",
}, () => {
  for (const value of ["../../main", "latest", "1.0.0; touch /tmp/should-not-exist", "1.0.0\n"]) {
    const result = spawnSync("bash", [script, value], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid Desktop version/);
  }
});

test("shell bootstrap refuses altered downloads and cleans staging before any installation", {
  skip: process.platform === "win32",
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-bootstrap-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const commands = {
    id: "#!/bin/sh\necho 1000\n",
    uname: '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi\n',
    curl: `#!/bin/bash\nset -eu\nif [[ "$1" == "--version" ]]; then echo 'curl 8.4.0'; exit 0; fi\nwhile [[ "$#" -gt 0 ]]; do\n if [[ "$1" == "--output" ]]; then out="$2"; shift 2; else shift; fi\ndone\ncase "$out" in\n */SHA256SUMS) printf '%s  %s\\n' '${"a".repeat(64)}' 'openbot-desktop-0.1.0-alpha.2-linux-x64.AppImage' > "$out";;\n *) printf 'altered installer' > "$out";;\nesac\n`,
  };
  for (const [name, body] of Object.entries(commands))
    await writeFile(join(directory, name), body, { mode: 0o755 });
  const result = spawnSync("bash", [script, "0.1.0-alpha.2"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /checksum mismatch; nothing was installed/);
});

test("native PowerShell bounds streamed downloads, redirects, cancellation and exclusive files", {
  skip: process.platform !== "win32",
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-windows-download-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const executable of ["pwsh", "powershell"]) {
    const result = spawnSync(
      executable,
      [
        "-NoProfile",
        "-File",
        fileURLToPath(new URL("./install-desktop-download.test.ps1", import.meta.url)),
        "-ScriptPath",
        fileURLToPath(new URL("./install-desktop.ps1", import.meta.url)),
        "-TestDirectory",
        directory,
      ],
      // Compiling the C# fixture with Add-Type dominates the run and has taken 10–32 s on hosted
      // Windows runners; the cases themselves are bounded (two 1 s cancellations). The limit only
      // stops a hung shell.
      { encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(
      result.status,
      0,
      `${executable}: ${result.error?.message ?? `exit ${result.status} ${result.signal ?? ""}`}\n${result.stdout}${result.stderr}`,
    );
    assert.match(result.stdout, /"cases":9/);
  }
});

test("Linux installation recovers from copy failure and retains a concurrent destination", {
  skip: process.platform !== "linux",
}, async (t) => {
  const { createHash } = await import("node:crypto");
  const { mkdir, readdir } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "openbot-linux-install-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const commands = join(directory, "bin");
  await mkdir(commands);
  const fixtureHome = join(directory, "fixture-home");
  await mkdir(fixtureHome);
  const isolated = join(directory, "installer.sh");
  const original = await readFile(script, "utf8");
  // Use the real script with a task-owned home path without changing the process HOME environment.
  await writeFile(
    isolated,
    original
      .replace(
        "set -euo pipefail",
        `set -euo pipefail\nfixture_home='${fixtureHome.replaceAll("'", "'\\''")}'`,
      )
      .replaceAll("$HOME", "$fixture_home"),
  );
  const bytes = "OpenBot installation fixture";
  const digest = createHash("sha256").update(bytes).digest("hex");
  const files = {
    id: "#!/bin/sh\necho 1000\n",
    uname: '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi\n',
    curl: `#!/bin/bash\nset -eu\nif [[ "$1" == "--version" ]]; then echo 'curl 8.4.0'; exit 0; fi\nwhile [[ "$#" -gt 0 ]]; do if [[ "$1" == "--output" ]]; then out="$2"; shift 2; else shift; fi; done\ncase "$out" in */SHA256SUMS) printf '%s  %s\\n' '${digest}' 'openbot-desktop-0.1.0-alpha.2-linux-x64.AppImage' > "$out";; *) printf '%s' '${bytes}' > "$out";; esac\n`,
    install: "#!/bin/sh\nexit 1\n",
  };
  for (const [name, body] of Object.entries(files))
    await writeFile(join(commands, name), body, { mode: 0o755 });
  const run = () =>
    spawnSync("bash", [isolated, "0.1.0-alpha.2"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${commands}:${process.env.PATH}` },
    });
  const parent = join(fixtureHome, ".local/opt/openbot"),
    target = join(parent, "0.1.0-alpha.2");
  assert.equal(run().status, 1);
  assert.deepEqual(await readdir(parent), []);
  await rm(join(commands, "install"));
  const success = run();
  assert.equal(success.status, 0, success.stderr);
  assert.equal(await readFile(join(target, "openbot.AppImage"), "utf8"), bytes);
  assert.equal(run().status, 0);
  await rm(target, { recursive: true });
  await writeFile(
    join(commands, "mv"),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This is Bash positional-argument syntax.
    '#!/bin/bash\nset -eu\ndestination="${@: -1}"\nmkdir "$destination"\nprintf "retained" > "$destination/race"\nexec /bin/mv "$@"\n',
    { mode: 0o755 },
  );
  const raced = run();
  assert.equal(raced.status, 1);
  assert.match(raced.stderr, /Another installation appeared/);
  assert.equal(await readFile(join(target, "race"), "utf8"), "retained");
  assert.deepEqual(await readdir(parent), ["0.1.0-alpha.2"]);
});

test("shell bootstrap rejects curl without unknown-length bounds before network access", {
  skip: process.platform === "win32",
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-curl-version-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "id"), "#!/bin/sh\necho 1000\n", { mode: 0o755 });
  await writeFile(
    join(directory, "uname"),
    '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi\n',
    { mode: 0o755 },
  );
  for (const version of ["7.88.1", "8.3.0", "unrecognized", "999999999.0.0"]) {
    await writeFile(
      join(directory, "curl"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'curl ${version}'; else echo 'NETWORK_WAS_CALLED' >&2; exit 97; fi\n`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires curl 8\.4\.0 or newer/);
    assert.doesNotMatch(result.stderr, /NETWORK_WAS_CALLED|unbound variable/);
  }
});
