import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createMcpPlugin } from "./create-mcp-plugin.mjs";
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("creates a standalone pinned plugin and refuses to overwrite an existing project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openbot-plugin-starter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createMcpPlugin(join(root, "plugin"));
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["@modelcontextprotocol/sdk"], "1.30.0");
  assert.equal(manifest.dependencies.zod, "4.6.2");
  for (const name of ["plugin-example.ts", "plugin-example-view.ts"])
    assert.deepEqual(
      await readFile(join(directory, name)),
      await readFile(join(repository, "packages/mcp-example/src", name)),
    );
  assert.deepEqual(
    await readFile(join(directory, "LICENSE")),
    await readFile(join(repository, "packages/mcp-example/LICENSE")),
  );
  const source = await readFile(join(directory, "plugin-example.ts"), "utf8");
  assert.doesNotMatch(source, /from ["']@openbot\//u);
  assert.match(source, /registerResource/u);
  await writeFile(join(directory, "keep.txt"), "user file");
  await assert.rejects(createMcpPlugin(directory), { code: "EEXIST" });
  assert.equal(await readFile(join(directory, "keep.txt"), "utf8"), "user file");
});

test("generated standalone project uses the real MCP SDK over owned loopback", {
  timeout: 20000,
}, async (t) => {
  // Canonical paths keep the regression visible on hosts with aliased temp directories.
  const root = await realpath(await mkdtemp(join(tmpdir(), "openbot-plugin-transport-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createMcpPlugin(join(root, "plugin"));
  await symlink(
    join(repository, "node_modules"),
    join(directory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const program = `
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const {startExamplePlugin}=await import(pathToFileURL(process.argv[2]).href);
const server=await startExamplePlugin(0);
const client=new Client({name:'synthetic-generator-check',version:'1.0.0'});
try {
 await client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint)));
 assert.deepEqual((await client.listTools()).tools.map(x=>x.name).sort(),['append_note','sum_numbers']);
 const sum=await client.callTool({name:'sum_numbers',arguments:{a:13,b:29}});
 assert.deepEqual(sum.content,[{type:'text',text:'42'}]);
 await client.callTool({name:'append_note',arguments:{text:'Synthetic note'}});
 assert.equal((await client.readResource({uri:'notes://current'})).contents[0].text,'Synthetic note');
 const view=(await client.readResource({uri:'ui://notebook/view.html'})).contents[0];
 assert.equal(view.mimeType,'text/html;profile=mcp-app');
 assert.deepEqual(view._meta.ui.csp,{connectDomains:[],resourceDomains:[]});
 assert.equal((await client.getPrompt({name:'review_note',arguments:{note:'Synthetic note'}})).messages[0].content.text,'Review this note for clarity: Synthetic note');
 assert.equal((await fetch(server.endpoint,{method:'POST',headers:{Origin:'https://refused.invalid'},body:'{}'})).status,403);
 assert.equal((await fetch(server.endpoint,{method:'POST',body:'x'.repeat(24*1024+1)})).status,413);
 assert.equal((await fetch(server.endpoint)).status,405);
} finally {
 try { await client.close(); } finally { await server.close(); }
}
console.log('MCP tool/resource/prompt/view, origin, size and method checks passed; client and server closed.');
`;
  // Give the driver its own entry identity. Under node -e, argv[1] was the imported
  // example, activating its standalone CLI listener in addition to the owned port0 server.
  const driver = join(directory, "verify-example.mjs");
  await writeFile(driver, program);
  const env = Object.fromEntries(
    ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", driver, join(directory, "plugin-example.ts")],
    { cwd: directory, env, encoding: "utf8", timeout: 15000 },
  );
  const diagnostic = JSON.stringify({
    error: result.error?.code ?? null,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  // A POSIX SIGTERM handler can exit0 after spawnSync's deadline: status alone misses that leak.
  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.status, 0, diagnostic);
  assert.match(result.stdout, /checks passed; client and server closed\./);
  assert.doesNotMatch(result.stdout, /Example MCP endpoint:/);
});
