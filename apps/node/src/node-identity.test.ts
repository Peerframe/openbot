import { once } from "node:events";
import { createServer } from "node:http";
import { type NodeEnv, nodeEnvSchema } from "@openbot/config";
import { createSilentLogger } from "@openbot/logging";
import type { NodeEnrollmentResult } from "@openbot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeCredentialStore } from "./credential-store.js";
import {
  NodeEnrollmentRequiredError,
  nodeEnrollmentUrl,
  prepareNodeIdentity,
} from "./node-identity.js";

const NODE_ID = "node-test";
const CREDENTIAL = `obn_${"A".repeat(43)}`;
const TOKEN = `obenr_${"B".repeat(43)}`;
const IDENTITY: NodeEnrollmentResult = {
  format: "openbot.node-identity/v1",
  nodeId: NODE_ID,
  credential: CREDENTIAL,
  enrolledAt: "2026-09-29T12:00:00.000Z",
};
function env(extra: Record<string, unknown> = {}): NodeEnv {
  return nodeEnvSchema.parse({
    OPENBOT_NODE_ID: NODE_ID,
    OPENBOT_NODE_SERVER_URL: "ws://127.0.0.1:8787/ws",
    ...extra,
  });
}
function memoryStore(initial?: NodeEnrollmentResult) {
  const events: string[] = [];
  const saved: NodeEnrollmentResult[] = [];
  const store: NodeCredentialStore = {
    load: vi.fn(async (nodeId: string) => {
      events.push(`load:${nodeId}`);
      return initial;
    }),
    save: vi.fn(async (identity) => {
      events.push("save");
      saved.push(identity);
    }),
  };
  return { store, events, saved };
}
function mockFetch(response: Response) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
}
const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
afterEach(() => vi.restoreAllMocks());

describe("nodeEnrollmentUrl", () => {
  it("maps ws/wss and strips path, query and hash", () => {
    expect(nodeEnrollmentUrl("wss://h.example:9/x?y#z")).toBe(
      "https://h.example:9/api/v1/nodes/enroll",
    );
    expect(nodeEnrollmentUrl("ws://127.0.0.1:8787/ws")).toBe(
      "http://127.0.0.1:8787/api/v1/nodes/enroll",
    );
  });
});
describe("prepareNodeIdentity credential sources", () => {
  it("refuses a programmatic environment credential without both switches and file store", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { store } = memoryStore();
    await expect(
      prepareNodeIdentity(
        { ...env(), OPENBOT_NODE_CREDENTIAL: CREDENTIAL },
        store,
        createSilentLogger(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("Environment Node credentials are not enabled for this profile.");
    expect(store.load).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("returns a loaded credential without network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { store, events } = memoryStore(IDENTITY);
    await expect(
      prepareNodeIdentity(
        env({ OPENBOT_NODE_ENROLLMENT_TOKEN: TOKEN }),
        store,
        createSilentLogger(),
        new AbortController().signal,
      ),
    ).resolves.toBe(CREDENTIAL);
    expect(events).toEqual([`load:${NODE_ID}`]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("propagates a persistence load failure without network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const failure = new Error("store invalid");
    const store: NodeCredentialStore = {
      load: vi.fn(async () => {
        throw failure;
      }),
      save: vi.fn(),
    };
    await expect(
      prepareNodeIdentity(
        env({ OPENBOT_NODE_ENROLLMENT_TOKEN: TOKEN }),
        store,
        createSilentLogger(),
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("throws the fixed enrollment error without a token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      prepareNodeIdentity(
        env(),
        memoryStore().store,
        createSilentLogger(),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(NodeEnrollmentRequiredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("does not create a connection after caller cancellation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareNodeIdentity(
        env({ OPENBOT_NODE_ENROLLMENT_TOKEN: TOKEN }),
        memoryStore().store,
        createSilentLogger(),
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
describe("prepareNodeIdentity enrollment", () => {
  const run = (store: NodeCredentialStore) =>
    prepareNodeIdentity(
      env({ OPENBOT_NODE_ENROLLMENT_TOKEN: TOKEN }),
      store,
      createSilentLogger(),
      new AbortController().signal,
    );
  it("posts once, saves, then returns the credential", async () => {
    const fetchSpy = mockFetch(json(IDENTITY));
    const { store, events, saved } = memoryStore();
    await expect(run(store)).resolves.toBe(CREDENTIAL);
    expect(events).toEqual([`load:${NODE_ID}`, "save"]);
    expect(saved).toEqual([IDENTITY]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:8787/api/v1/nodes/enroll");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ nodeId: NODE_ID, token: TOKEN }));
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each<[string, Response, string]>([
    [
      "wrong nodeId",
      json({ ...IDENTITY, nodeId: "other" }),
      "Server returned an invalid Node identity.",
    ],
    [
      "unknown field",
      json({ ...IDENTITY, extra: true }),
      "Server returned an invalid Node identity.",
    ],
    [
      "status failure",
      json(IDENTITY, { status: 401 }),
      "Server rejected the one-time Node enrollment token.",
    ],
    [
      "declared oversize",
      new Response("{}", { headers: { "content-length": "8193" } }),
      "Node enrollment response is too large.",
    ],
    [
      "actual oversize",
      new Response("x".repeat(8 * 1024 + 1)),
      "Node enrollment response is too large.",
    ],
  ])("refuses %s without saving", async (_name, response, message) => {
    mockFetch(response);
    const { store } = memoryStore();
    await expect(run(store)).rejects.toThrow(message);
    expect(store.save).not.toHaveBeenCalled();
  });
  it("accepts exactly 8 KiB of declared size", async () => {
    const text = JSON.stringify(IDENTITY).padEnd(8 * 1024, " ");
    mockFetch(new Response(text, { headers: { "content-length": String(8 * 1024) } }));
    await expect(run(memoryStore().store)).resolves.toBe(CREDENTIAL);
  });
  it("cancels a declared-oversize body without reading it", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    mockFetch(new Response(body, { headers: { "content-length": "9000" } }));
    await expect(run(memoryStore().store)).rejects.toThrow(
      "Node enrollment response is too large.",
    );
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
  it("returns promptly when cancel never settles and releases the lock", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 + 1));
      },
      cancel: () => new Promise<void>(() => {}),
    });
    mockFetch(new Response(body));
    await expect(run(memoryStore().store)).rejects.toThrow(
      "Node enrollment response is too large.",
    );
    expect(body.locked).toBe(false);
  });
  it("keeps the stream read failure as the primary rejection and releases the lock", async () => {
    const failure = new Error("read failed");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
    });
    mockFetch(new Response(body));
    const { store } = memoryStore();
    await expect(run(store)).rejects.toBe(failure);
    expect(body.locked).toBe(false);
    expect(store.save).not.toHaveBeenCalled();
  });
  it("propagates a save failure after a valid response", async () => {
    mockFetch(json(IDENTITY));
    const failure = new Error("persist failed");
    const store: NodeCredentialStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {
        throw failure;
      }),
    };
    await expect(run(store)).rejects.toBe(failure);
  });
  it("releases a successful stream reader before saving", async () => {
    const response = json(IDENTITY);
    mockFetch(response);
    const store: NodeCredentialStore = {
      load: async () => undefined,
      save: vi.fn(async () => {
        expect(response.body?.locked).toBe(false);
      }),
    };
    await expect(run(store)).resolves.toBe(CREDENTIAL);
    expect(store.save).toHaveBeenCalledOnce();
  });
  it("preserves byte rejection ahead of a rejected status or failing cleanup", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("private cancel failure");
    });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8193));
      },
      cancel,
    });
    mockFetch(new Response(body, { status: 401 }));
    const { store } = memoryStore();
    await expect(run(store)).rejects.toThrow("Node enrollment response is too large.");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(store.save).not.toHaveBeenCalled();
  });
  it("refuses malformed JSON without saving and releases the reader", async () => {
    const response = new Response("{");
    mockFetch(response);
    const { store } = memoryStore();
    await expect(run(store)).rejects.toBeInstanceOf(SyntaxError);
    expect(response.body?.locked).toBe(false);
    expect(store.save).not.toHaveBeenCalled();
  });
  it("binds the existing 10 second deadline to the actual fetch signal", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const reason = new DOMException("deadline fixture", "TimeoutError");
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error("Missing fetch signal");
      deadline.abort(reason);
      signal.throwIfAborted();
      throw new Error("Deadline did not stop fetch");
    });
    const { store } = memoryStore();
    await expect(run(store)).rejects.toBe(reason);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(store.save).not.toHaveBeenCalled();
  });
  it("cancels a real localhost fetch while its response body is incomplete", async () => {
    const nativeFetch = globalThis.fetch;
    const received = new Promise<Response>((resolve) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
        const response = await nativeFetch(...args);
        resolve(response);
        return response;
      });
    });
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"format":');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture port");
    const controller = new AbortController();
    const { store } = memoryStore();
    const pending = prepareNodeIdentity(
      env({
        OPENBOT_NODE_SERVER_URL: `ws://127.0.0.1:${address.port}/ws`,
        OPENBOT_NODE_ENROLLMENT_TOKEN: TOKEN,
      }),
      store,
      createSilentLogger(),
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    try {
      const response = await received;
      await vi.waitFor(() => expect(response.body?.locked).toBe(true));
      controller.abort();
      await rejected;
      expect(response.body?.locked).toBe(false);
      expect(requests).toBe(1);
      expect(store.save).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
