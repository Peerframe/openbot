const nodeId = process.argv[2] ?? process.env.OPENBOT_NODE_ID;
const ownerPassword = process.env.OPENBOT_OWNER_PASSWORD;
if (nodeId === undefined || nodeId.length === 0) {
  throw new Error("Pass a Node id or set OPENBOT_NODE_ID.");
}
if (ownerPassword === undefined || ownerPassword.length === 0) {
  throw new Error("OPENBOT_OWNER_PASSWORD is required.");
}

const serverUrl = controlPlaneUrl(
  process.env.OPENBOT_NODE_SERVER_URL ?? "ws://localhost:3001/ws/nodes",
);
const origin =
  process.env.OPENBOT_ALLOWED_ORIGINS?.split(",")[0]?.trim() ?? "http://localhost:5173";
const login = await fetch(new URL("/api/v1/auth/login", serverUrl), {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({ password: ownerPassword }),
  signal: AbortSignal.timeout(10_000),
});
if (!login.ok) throw new Error(`Owner login failed with HTTP ${login.status}.`);
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
if (cookie === undefined) throw new Error("Owner login did not return a session cookie.");

const response = await fetch(new URL("/api/v1/nodes/enrollment-tokens", serverUrl), {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin },
  body: JSON.stringify({ nodeId }),
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`Enrollment token request failed with HTTP ${response.status}.`);
const result = enrollmentResponse(await response.json());

console.info(`Node: ${nodeId}`);
console.info(`Expires: ${result.expiresAt}`);
console.info(`OPENBOT_NODE_ENROLLMENT_TOKEN=${result.token}`);

function controlPlaneUrl(nodeServerUrl: string): URL {
  const url = new URL(nodeServerUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

interface EnrollmentResponse {
  readonly token: string;
  readonly expiresAt: string;
}

/** Narrows the untrusted Server body to the two fields this CLI prints. */
function enrollmentResponse(value: unknown): EnrollmentResponse {
  if (
    typeof value === "object" &&
    value !== null &&
    "token" in value &&
    "expiresAt" in value &&
    typeof value.token === "string" &&
    typeof value.expiresAt === "string"
  ) {
    return { token: value.token, expiresAt: value.expiresAt };
  }
  throw new Error("Server returned an invalid enrollment token response.");
}
