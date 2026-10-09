import { WorkConflict } from "@openbot/work";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { PluginStore } from "./plugin-store.js";
import { pluginManifest, pluginValidator } from "./plugin-values.js";
import { normalizePluginEndpoint, publicPluginAddress } from "./plugin-transport.js";
const execute = promisify(execFile),
  root = fileURLToPath(new URL("../../../", import.meta.url));
const python = join(root, "apps/server-python/.worker-venv/bin/python");
const authority = async <T>(publish: () => Promise<T>) => publish();
const sample = () => ({
  ...pluginManifest(
    "Synthetic",
    "https://example.com/mcp",
    [{ name: "read", description: "Read", inputSchema: { type: "object", properties: {} } }],
    [],
    [],
  ),
  id: randomUUID(),
  revision: randomUUID(),
  enabled: false,
  createdAt: new Date().toISOString(),
  token: "synthetic-private-token",
  grants: [],
});
it("encrypted state restores exactly after the authority commit rejects and after a pending journal", async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "openbot-plugin-store-")),
    path = join(directory, "state.json");
  try {
    const store = new PluginStore(path);
    await store.verify();
    const item = sample();
    await store.transaction(authority, (s) => {
      s.plugins.push(item);
    });
    const before = readFileSync(path);
    expect(before.toString()).not.toContain(item.token);
    await expect(
      store.transaction(
        async (publish) => {
          await publish();
          throw new Error("Synthetic authority expiry.");
        },
        (s) => {
          s.plugins[0]!.enabled = true;
        },
      ),
    ).rejects.toThrow();
    expect(readFileSync(path)).toEqual(before);
    expect((await store.read()).plugins[0]!.enabled).toBe(false);
    await store.transaction(authority, (s) => {
      s.plugins[0]!.enabled = true;
    });
    writeFileSync(
      join(directory, ".state.json.pending"),
      JSON.stringify({ version: 1, previous: before.toString("base64") }),
      { mode: 0o600 },
    );
    const restored = new PluginStore(path);
    await restored.verify();
    expect((await restored.read()).plugins[0]!.enabled).toBe(false);
    expect(existsSync(join(directory, ".state.json.pending"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it("independent plugin writers share the lease and refuse a substituted key", async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "openbot-plugin-lock-")),
    path = join(directory, "state.json");
  try {
    const a = new PluginStore(path),
      b = new PluginStore(path);
    await a.verify();
    await b.verify();
    const order: string[] = [];
    await Promise.all([
      a.transaction(authority, async (s) => {
        order.push("first");
        await new Promise((r) => setTimeout(r, 35));
        s.plugins.push(sample());
        order.push("released");
      }),
      b.transaction(authority, (s) => {
        order.push("second");
        expect(s.plugins.length).toBe(1);
      }),
    ]);
    expect(order).toEqual(["first", "released", "second"]);
    const key = join(directory, "state.json.key"),
      outside = join(directory, "outside");
    writeFileSync(outside, readFileSync(key), { mode: 0o600 });
    rmSync(key);
    symlinkSync(outside, key);
    await expect(a.read()).rejects.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it.skipIf(!existsSync(python))(
  "retained Python decrypts TS state and TS observes its newer revision",
  async () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "openbot-plugin-python-")),
      path = join(directory, "state.json");
    try {
      const store = new PluginStore(path);
      await store.verify();
      const item = sample();
      await store.transaction(authority, (s) => {
        s.plugins.push(item);
      });
      const child = await execute(
        python,
        [
          "-I",
          "-B",
          "-c",
          `import asyncio,json,sys
sys.path.insert(0,sys.argv[1])
from openbot_server.plugin_store import FilePluginStore
async def run():
 store=FilePluginStore(sys.argv[2])
 state=await store.read()
 assert state['plugins'][0]['token']=='synthetic-private-token'
 async def change(s):
  s['plugins'][0]['enabled']=True
  s['plugins'][0]['revision']=sys.argv[3]
 await store.transaction(change)
asyncio.run(run())`,
          join(root, "apps/server-python/src"),
          path,
          randomUUID(),
        ],
        {
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
          timeout: 10000,
          maxBuffer: 1024,
        },
      );
      expect(child.stdout).toBe("");
      const current = (await store.read()).plugins[0]!;
      expect(current.enabled).toBe(true);
      expect(current.revision).not.toBe(item.revision);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
it("bounds imported draft-07 schemas before compiling, while allowing data keys", () => {
  for (const schema of [
    { type: "object", $ref: "https://example.com/schema" },
    { type: "object", properties: { x: { type: "string", pattern: "(a+)+" } } },
    { type: "object", required: 1 },
    { type: "object", properties: { x: { type: "nonsense" } } },
  ])
    expect(() => pluginValidator(schema)).toThrow();
  expect(
    pluginValidator({
      type: "object",
      properties: { $ref: { type: "string" } },
      required: ["$ref"],
    })({ $ref: "data" }).valid,
  ).toBe(true);
});
it("retains public address bounds and refuses credentials, ambiguous numeric and local destinations", () => {
  for (const address of [
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "192.0.0.8",
    "224.0.0.1",
    "240.0.0.1",
    "::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
    "2001::1",
    "::ffff:8.8.8.8",
  ])
    expect(publicPluginAddress(address), address).toBe(false);
  for (const address of ["1.1.1.1", "8.8.8.8", "192.0.0.9", "2001:4860:4860::8888", "2001:1::1"])
    expect(publicPluginAddress(address), address).toBe(true);
  for (const endpoint of [
    "https://@example.com/mcp",
    "https://example.com/mcp?x",
    "https://127.0.0.1/mcp",
    "https://2130706433/mcp",
    "http://example.com/mcp",
    "https://service.internal/mcp",
  ])
    expect(() => normalizePluginEndpoint(endpoint)).toThrow();
});

it("preserves a trusted read caller's control refusal while redacting corrupt store bytes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openbot-plugin-read-")));
  try {
    const path = join(root, "state.json"),
      store = new PluginStore(path);
    await store.verify();
    const conflict = new WorkConflict("corrections_changed");
    await expect(
      store.withRead(async () => {
        throw conflict;
      }),
    ).rejects.toBe(conflict);
    expect(await store.withRead(async (s) => s.plugins.length)).toBe(0);
    writeFileSync(path, "synthetic invalid private contents", { mode: 0o600 });
    let called = false;
    await expect(
      store.withRead(async () => {
        called = true;
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(called).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
