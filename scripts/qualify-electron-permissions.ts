/** Compares actual permission enforcement without touching user files or an installed application. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
assert.equal(process.platform, "darwin", "This evidence is scoped to the macOS Electron build.");
const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const electron: string = require("electron");
const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-electron-permissions-")));
const allowed = join(directory, "allowed"), denied = join(directory, "denied.txt");
const run = (command: string, args: string[]) => new Promise<{ code: number | null; records: string }>((resolve, reject) => {
  const child = spawn(command, args, { env: { PATH: "/usr/bin:/bin", TMPDIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
  let records = "", bytes = 0;
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Qualification deadline")); }, 30000);
  child.stdout.on("data", (b: Buffer) => { records += b; bytes += b.length; if (bytes > 65536) child.kill("SIGKILL"); });
  child.stderr.on("data", (b: Buffer) => { bytes += b.length; if (bytes > 65536) child.kill("SIGKILL"); });
  child.once("error", reject); child.once("exit", code => { clearTimeout(timer); resolve({ code, records }); });
});
try {
  await mkdir(allowed, { mode: 0o700 }); await writeFile(denied, "synthetic denied content", { mode: 0o600 });
  const probe = join(allowed, "probe.cjs"), main = join(directory, "main.cjs");
  await writeFile(probe, `const fs=require('node:fs'),cp=require('node:child_process');
const result={node:process.versions.node,permissionEnabled:typeof process.permission==='object',fileDenied:false,childDenied:false};
try{fs.readFileSync(process.argv[2]);}catch(e){result.fileDenied=e.code==='ERR_ACCESS_DENIED';}
try{const child=cp.spawn('/usr/bin/true');child.on('error',()=>{});}catch(e){result.childDenied=e.code==='ERR_ACCESS_DENIED';}
if(process.parentPort)process.parentPort.postMessage(result);else console.log(JSON.stringify(result));
setTimeout(()=>process.exit(0),25);
`, { mode: 0o600 });
  await writeFile(main, `const {app,utilityProcess}=require('electron');app.setPath('userData',${JSON.stringify(join(directory,"profile"))});app.disableHardwareAcceleration();
app.whenReady().then(()=>{app.dock?.hide();const child=utilityProcess.fork(${JSON.stringify(probe)},[${JSON.stringify(denied)}],{execArgv:['--permission',${JSON.stringify('--allow-fs-read='+allowed)}],env:{PATH:'/usr/bin:/bin'},stdio:'pipe'});child.on('message',m=>console.log(JSON.stringify(m)));child.on('exit',code=>app.exit(code));}).catch(()=>app.exit(1));
`, { mode: 0o600 });
  const node = await run(process.execPath, ["--permission", `--allow-fs-read=${allowed}`, probe, denied]);
  const utility = await run(electron, [main]);
  assert.equal(node.code, 0); assert.equal(utility.code, 0);
  const native = JSON.parse(node.records.trim()), embedded = JSON.parse(utility.records.trim());
  assert(native.permissionEnabled && native.fileDenied && native.childDenied, "Standalone baseline must enforce both refusals.");
  const version = JSON.parse(await readFile(join(dirname(require.resolve("electron/package.json")), "package.json"), "utf8")).version;
  console.log(JSON.stringify({ platform:process.platform, arch:process.arch, electron:version, standalone:native, utility:embedded,
    qualified:!!(embedded.permissionEnabled && embedded.fileDenied && embedded.childDenied), syntheticOnly:true }));
} finally { await rm(directory, { recursive:true, force:true }); }
