import { once } from "node:events";
import { createServer, type IncomingMessage, request } from "node:http";

/** Target state observed independently of the relayed browser service. */
export interface ObservedTarget {
  readonly submitted: unknown;
}

export type ResponseLossReceipt =
  | { upstreamClickRequests: number; upstreamSuccess: true; targetSubmitted: 1 }
  | { failed: true; code: "fault_fixture_failed" };

export interface ResponseLossRelay {
  readonly url: string;
  close(): void;
}

const REQUEST_LIMIT_BYTES = 65536;
const RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15000;
const SUBMISSION_WAIT_MS = 3000;
const SUBMISSION_POLL_MS = 25;
const RELAY_REQUEST_TIMEOUT_MS = 20000;

async function readBounded(
  stream: AsyncIterable<unknown>,
  limit: number,
  overflow: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError("Fixture stream must carry bytes");
    size += chunk.length;
    if (size > limit) throw new Error(overflow);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function independentSubmission(target: ObservedTarget): Promise<boolean> {
  const deadline = Date.now() + SUBMISSION_WAIT_MS;
  while (target.submitted !== 1 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, SUBMISSION_POLL_MS));
  return target.submitted === 1;
}

/** Owned loopback fault fixture. This is neither an egress proxy nor a product transport. */
export async function responseLossRelay(
  upstream: string,
  targetState: ObservedTarget,
  receipt: (value: ResponseLossReceipt) => Promise<void>,
): Promise<ResponseLossRelay> {
  const origin = new URL(upstream);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1")
    throw new Error("Fault fixture requires the owned loopback upstream");
  let clicks = 0;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = await readBounded(incoming, REQUEST_LIMIT_BYTES, "Fixture request overflow");
      const isClick = incoming.url === "/click" && incoming.method === "POST";
      if (isClick && ++clicks !== 1) throw new Error("Original click was retried");
      // Native HTTP has no automatic retry; preserve exactly one original request.
      const forwarded = request({
        hostname: origin.hostname,
        port: origin.port,
        path: incoming.url ?? "/",
        method: incoming.method ?? "GET",
        headers: incoming.headers,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const responseReady = new Promise<IncomingMessage>((resolve, reject) => {
        forwarded.once("response", resolve);
        forwarded.once("error", reject);
      });
      forwarded.end(body);
      const response = await responseReady;
      const content = await readBounded(
        response,
        RESPONSE_LIMIT_BYTES,
        "Fixture response overflow",
      );
      if (isClick) {
        if (response.statusCode !== 200) throw new Error("Click did not complete upstream");
        if (!(await independentSubmission(targetState)))
          throw new Error("No independent target submission");
        await receipt({ upstreamClickRequests: clicks, upstreamSuccess: true, targetSubmitted: 1 });
        outgoing.destroy();
        return;
      }
      if (response.statusCode === undefined) throw new Error("Fixture upstream omitted status");
      outgoing.writeHead(response.statusCode, response.headers);
      outgoing.end(content);
    } catch (error) {
      await receipt({ failed: true, code: "fault_fixture_failed" });
      outgoing.destroy(error instanceof Error ? error : undefined);
    }
  });
  server.requestTimeout = RELAY_REQUEST_TIMEOUT_MS;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Fault fixture listener has no loopback port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
