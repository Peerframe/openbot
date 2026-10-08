import { Agent, request } from "node:http";
import { executionNodeSchema, browserResultSchema } from "@openbot/protocol";
import { z } from "zod";
import { refuse } from "./owner-transaction.js";
import { peerForwarded } from "./config.js";

export const runtimePrefix = "/_openbot/p4/";
const binding = z.strictObject({
  nodeId: z.string().max(128),
  connectionId: z.string().uuid(),
  credentialDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const runtimeSnapshotSchema = z.strictObject({
  nodes: z.array(executionNodeSchema).max(4096),
  revision: z.number().int().nonnegative(),
  bindings: z.array(binding).max(4096),
  browserRoutes: z.record(z.string().max(128), z.string().max(128)),
  humanControl: z.boolean(),
  legacyHumanControl: z.boolean(),
});
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;
export type RuntimeBinding = z.infer<typeof binding>;
export interface RuntimeAccess {
  command(
    dispatch: { ticketId: string; wire: string },
    signal: AbortSignal,
  ): Promise<import("@openbot/protocol").BrowserResult>;
  snapshot(signal: AbortSignal): Promise<RuntimeSnapshot>;
  detach(nodeId: string, enrollmentToken: string | undefined, signal: AbortSignal): Promise<void>;
}
/** P4 socket owner only; fixed destinations, original session, no redirects/retry or ambient Agent. */
export class RuntimePort {
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4 });
  private readonly stop = new AbortController();
  constructor(
    private readonly upstream: string,
    private readonly publicOrigin: string,
    private readonly secure: boolean,
  ) {}
  close() {
    this.stop.abort();
    this.agent.destroy();
  }
  access(token: string | undefined, peer: string | undefined): RuntimeAccess {
    return {
      command: async (dispatch, signal) =>
        browserResultSchema.parse(
          await this.call(token, peer, signal, "browser-command", dispatch),
        ),
      detach: async (nodeId, enrollmentToken, signal) => {
        await this.call(token, peer, signal, "detach", {
          nodeId,
          ...(enrollmentToken ? { enrollmentToken } : {}),
        });
      },
      snapshot: async (signal) =>
        runtimeSnapshotSchema.parse(await this.call(token, peer, signal, "snapshot")),
    };
  }
  private async call(
    token: string | undefined,
    peer: string | undefined,
    signal: AbortSignal,
    operation: "snapshot" | "detach" | "browser-command",
    body?: unknown,
  ): Promise<unknown> {
    const bounded = AbortSignal.any([
      signal,
      this.stop.signal,
      AbortSignal.timeout(operation === "browser-command" ? 30000 : 4000),
    ]);
    return new Promise((resolve, reject) => {
      const fail = () => {
        try {
          refuse(503, "worker_runtime_unavailable");
        } catch (error) {
          reject(error);
        }
      };
      const outgoing = request(
        new URL(runtimePrefix + operation, this.upstream),
        {
          method: body === undefined ? "GET" : "POST",
          agent: this.agent,
          signal: bounded,
          maxHeaderSize: 8192,
          headers: {
            Host: new URL(this.publicOrigin).host,
            Forwarded: peerForwarded(peer),
            ...(token
              ? { Cookie: `${this.secure ? "__Host-openbot_session" : "openbot_session"}=${token}` }
              : {}),
            ...(body === undefined
              ? {}
              : { Origin: this.publicOrigin, "Content-Type": "application/json" }),
            Accept: "application/json",
            "Accept-Encoding": "identity",
          },
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            response.headers["content-encoding"] ||
            !response.headers["content-type"]?.startsWith("application/json")
          ) {
            response.destroy();
            fail();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > (operation === "browser-command" ? 8 : 4) * 1024 * 1024) {
              response.destroy();
              fail();
            } else chunks.push(chunk);
          });
          response.once("error", fail);
          response.once("end", () => {
            try {
              resolve(
                JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
              );
            } catch {
              fail();
            }
          });
        },
      );
      outgoing.once("error", fail);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
}
