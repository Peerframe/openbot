/** Real Server scenario; synthetic rows and peers are restricted to its owned fixture. */
import { scenarioStep as check } from "./scenario-step.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase } from "@openbot/db";
import { pluginHttpOperations } from "@openbot/protocol";
export async function qualifyPluginOwnership(options: {
  databaseUrl: string;
  origin: string;
  cookie: string;
  restart(): Promise<void>;
  endpoint: string;
  token: string;
  storePath: string;
}) {
  const database = createDatabase(options.databaseUrl),
    sql = database.client,
    bot = randomUUID(),
    channel = randomUUID();
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    origin = options.origin,
    cookie = options.cookie,
  ) => {
    const r = await fetch(origin + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: options.origin,
        Host: new URL(options.origin).host,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const snapshot = async () => {
    const r = await request("/api/v1/plugins");
    assert.equal(r.status, 200);
    return r.body;
  };
  try {
    await sql`INSERT INTO bots(id,name,role,computer_profile) VALUES(${bot},${"Plugins " + bot},'Synthetic','none')`;
    await sql`INSERT INTO channels(id,name,description) VALUES(${channel},${"Plugins " + channel},'Synthetic')`;
    await sql`INSERT INTO channel_bots(channel_id,bot_id) VALUES(${channel},${bot})`;

    await check("Owner authentication and Origin precede imported declarations", async () => {
      assert.equal(
        (await request("/api/v1/plugins/preview", "POST", {}, options.origin, "")).status,
        401,
      );
      const r = await fetch(options.origin + "/api/v1/plugins/preview", {
        method: "POST",
        headers: {
          Cookie: options.cookie,
          Origin: "https://foreign.invalid",
          "Content-Type": "application/json",
        },
        body: "broken",
      });
      assert.equal(r.status, 403);
    });
    await options.restart();
    const endpoint = {
      name: "Ownership fixture",
      endpoint: options.endpoint,
      token: options.token,
    };
    let plugin: any;
    await check("reviewed live MCP installation and content work with a restarted Server", async () => {
      const preview = await request("/api/v1/plugins/preview", "POST", endpoint);
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      const created = await request("/api/v1/plugins", "POST", {
        ...endpoint,
        reviewedDigest: preview.body.digest,
      });
      assert.equal(created.status, 201);
      plugin = created.body.plugin;
      assert(!("token" in plugin));
      assert.equal(plugin.enabled, false);
      const enabled = await request(`/api/v1/plugins/${plugin.id}`, "PATCH", {
        revision: plugin.revision,
        enabled: true,
      });
      assert.equal(enabled.status, 200);
      plugin = enabled.body.plugin;
      const granted = await request(`/api/v1/plugins/${plugin.id}/grants/${bot}`, "PUT", {
        revision: plugin.revision,
        tools: [],
        resources: [plugin.resources[0].uri],
        prompts: [],
      });
      assert.equal(granted.status, 200);
      plugin = granted.body.plugin;
      const content = await request(
        `/api/v1/channels/${channel}/bots/${bot}/plugin-content`,
        "POST",
        {
          pluginId: plugin.id,
          revision: plugin.revision,
          kind: "resource",
          name: plugin.resources[0].uri,
          arguments: {},
        },
      );
      assert.equal(content.status, 200, JSON.stringify(content.body));
      assert.equal(content.body.untrusted, true);
      assert(!(await readFile(options.storePath)).includes(Buffer.from(options.token)));
    });
    await check("failed live Bot guard leaves exact encrypted state unchanged", async () => {
      const before = await readFile(options.storePath),
        r = await request(`/api/v1/plugins/${plugin.id}/grants/${randomUUID()}`, "PUT", {
          revision: plugin.revision,
          tools: [],
          resources: [],
          prompts: [],
        });
      assert.equal(r.status, 404);
      assert.deepEqual(await readFile(options.storePath), before);
    });
    const before = await snapshot();
    await options.restart();
    await check(
      "process restart shares encrypted credentials, grants and newer revision",
      async () => {
        await options.restart();
        assert.deepEqual(await snapshot(), before);
        const preview = await request(`/api/v1/plugins/${plugin.id}/update/preview`, "POST", {
          revision: plugin.revision,
        });
        assert.equal(preview.status, 200);
        assert.equal(preview.body.changed, false);
        const disabled = await request(`/api/v1/plugins/${plugin.id}`, "PATCH", {
          revision: plugin.revision,
          enabled: false,
        });
        assert.equal(disabled.status, 200);
        plugin = disabled.body.plugin;
        await options.restart();
        assert.deepEqual((await snapshot()).plugins, [plugin]);
        const refused = await request(
          `/api/v1/channels/${channel}/bots/${bot}/plugin-content`,
          "POST",
          {
            pluginId: plugin.id,
            revision: plugin.revision,
            kind: "resource",
            name: plugin.resources[0].uri,
            arguments: {},
          },
        );
        assert.equal(refused.status, 403);
      },
    );
    await check("removal retains encrypted audit and no installation state", async () => {
      assert.equal(
        (await request(`/api/v1/plugins/${plugin.id}`, "DELETE", { revision: plugin.revision }))
          .status,
        200,
      );
      assert.deepEqual((await snapshot()).plugins, []);
    });

  } finally {
    await database.close();
  }
}
