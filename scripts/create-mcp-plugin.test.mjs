import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(join(tmpdir(), "openbot-plugin-transport-"));
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
const {startExamplePlugin}=await import(pathToFileURL(process.argv[1]).href);
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
 console.log('MCP tool/resource/prompt/view, origin, size and method checks passed.');
} finally { await client.close(); await server.close(); }
`;
  const env = Object.fromEntries(
    ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", program, join(directory, "plugin-example.ts")],
    { cwd: directory, env, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MCP tool\/resource\/prompt\/view/);
});
