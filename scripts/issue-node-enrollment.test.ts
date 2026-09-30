import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const entry = fileURLToPath(new URL("./issue-node-enrollment.ts", import.meta.url));

for (const scenario of [
  "success",
  "login-refused",
  "no-cookie",
  "enrollment-refused",
  "bad-body",
] as const) {
  test(`real enrollment CLI: ${scenario}`, { timeout: 15_000 }, async (t) => {
    const requests: {
      path: string;
      body: string;
      cookie: string | undefined;
      origin: string | undefined;
    }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        path: request.url ?? "",
        body: Buffer.concat(chunks).toString(),
        cookie: request.headers.cookie,
        origin: request.headers.origin,
      });
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/v1/auth/login") {
        if (scenario !== "no-cookie")
          response.setHeader("Set-Cookie", "fixture-session=owned; HttpOnly; Path=/");
        response.statusCode = scenario === "login-refused" ? 401 : 200;
        response.end("{}");
      } else {
        response.statusCode = scenario === "enrollment-refused" ? 403 : 200;
        response.end(
          JSON.stringify(
            scenario === "bad-body"
              ? { token: 7, expiresAt: null }
              : { token: "owned-fixture-token", expiresAt: "2030-01-01T00:00:00Z" },
          ),
        );
      }
    });
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    // Never inherit an Owner's credentials or endpoint; only this disposable HTTP fixture is used.
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("OPENBOT_")),
    );
    const child = spawn(process.execPath, [entry, "fixture-node"], {
      env: {
        ...environment,
        OPENBOT_NODE_SERVER_URL: `ws://127.0.0.1:${address.port}/ws/nodes?discard=1#discard`,
        OPENBOT_OWNER_PASSWORD: "owned-fixture-password",
        OPENBOT_ALLOWED_ORIGINS: "http://fixture.invalid, http://unused.invalid",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [code] = await once(child, "close");
    assert.equal(code === 0, scenario === "success", stderr);
    assert.deepEqual(requests[0], {
      path: "/api/v1/auth/login",
      body: '{"password":"owned-fixture-password"}',
      cookie: undefined,
      origin: "http://fixture.invalid",
    });
    const loginStops = scenario === "login-refused" || scenario === "no-cookie";
    assert.equal(requests.length, loginStops ? 1 : 2);
    if (!loginStops)
      assert.deepEqual(requests[1], {
        path: "/api/v1/nodes/enrollment-tokens",
        body: '{"nodeId":"fixture-node"}',
        cookie: "fixture-session=owned",
        origin: "http://fixture.invalid",
      });
    if (scenario === "success")
      assert.equal(
        stdout,
        "Node: fixture-node\nExpires: 2030-01-01T00:00:00Z\nOPENBOT_NODE_ENROLLMENT_TOKEN=owned-fixture-token\n",
      );
    else assert.equal(stdout, "");
    assert(!stderr.includes("owned-fixture-password") && !stderr.includes("owned-fixture-token"));
    if (scenario === "bad-body") assert.match(stderr, /invalid enrollment token response/);
  });
}
