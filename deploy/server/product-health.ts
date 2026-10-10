/** Reads only the configured local TLS endpoint with operator-provided certificate trust. */
import { readFile } from "node:fs/promises";
import { request } from "node:https";
const origin = new URL(process.env.OPENBOT_TS_PUBLIC_ORIGIN ?? "");
if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password)
  throw new Error("Explicit product HTTPS origin is required.");
const ca = await readFile(process.env.OPENBOT_TS_HEALTH_CA_PATH ?? "");
try {
  await new Promise<void>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: Number(process.env.OPENBOT_TS_PORT ?? "3001"),
      servername: origin.hostname, path: "/health", ca, headers: { Host: origin.host }, timeout: 2000,
    }, (response) => {
      let bytes = 0; const chunks: Buffer[] = [];
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) response.destroy(new Error("Invalid health response.")); else chunks.push(chunk); });
      response.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode !== 200 || value.ok !== true || value.execution?.owner !== "typescript-v1" || value.execution?.state !== "running") throw new Error("Product is unhealthy.");
          resolve();
        } catch (error) { reject(error); }
      });
    });
    req.once("timeout", () => req.destroy(new Error("Health deadline."))); req.once("error", reject); req.end();
  });
} catch { process.exitCode = 1; }
