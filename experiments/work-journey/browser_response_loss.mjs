import { once } from "node:events";
import { createServer, request } from "node:http";

/** Owned loopback fault fixture. This is neither an egress proxy nor a product transport. */
export async function responseLossRelay(upstream, targetState, receipt) {
  const origin = new URL(upstream);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1")
    throw Error("Fault fixture requires the owned loopback upstream");
  let clicks = 0;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 65536) throw Error("Fixture request overflow");
        chunks.push(chunk);
      }
      const isClick = incoming.url === "/click" && incoming.method === "POST";
      if (isClick && ++clicks !== 1) throw Error("Original click was retried");
      // Native HTTP has no automatic retry; preserve exactly one original request.
      const forwarded = request({
        hostname: origin.hostname,
        port: origin.port,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
        signal: AbortSignal.timeout(15000),
      });
      const responseReady = once(forwarded, "response");
      forwarded.end(Buffer.concat(chunks));
      const [response] = await responseReady;
      const body = [];
      size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw Error("Fixture response overflow");
        body.push(chunk);
      }
      if (isClick) {
        if (response.statusCode !== 200) throw Error("Click did not complete upstream");
        const deadline = Date.now() + 3000;
        while (targetState.submitted !== 1 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 25));
        if (targetState.submitted !== 1) throw Error("No independent target submission");
        await receipt({ upstreamClickRequests: clicks, upstreamSuccess: true, targetSubmitted: 1 });
        outgoing.destroy();
        return;
      }
      outgoing.writeHead(response.statusCode, response.headers);
      outgoing.end(Buffer.concat(body));
    } catch (error) {
      await receipt({ failed: true, code: "fault_fixture_failed" });
      outgoing.destroy(error);
    }
  });
  server.requestTimeout = 20000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
