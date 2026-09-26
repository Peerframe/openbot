import { describe, expect, it } from "vitest";
import {
  macOSNodeServiceConfigFormat,
  macOSNodeServiceConfigSchema,
  nodeEnvSchema,
  serverEnvSchema,
} from "./index.js";

const required = {
  OPENBOT_OWNER_PASSWORD: "owner-password-for-tests",
};
const nodeCredential = `obn_${"a".repeat(43)}`;
const enrollmentToken = `obenr_${"b".repeat(43)}`;

describe("server environment", () => {
  it("selects a known runtime without enabling inference or accepting commands", () => {
    expect(serverEnvSchema.parse(required).OPENBOT_AGENT_RUNTIME).toBe("typescript");
    expect(
      serverEnvSchema.parse({ ...required, OPENBOT_AGENT_RUNTIME: "python" }).OPENBOT_AGENT_RUNTIME,
    ).toBe("python");
    for (const value of ["", "automatic", "python3", "/tmp/worker.py", "python; echo ignored"]) {
      expect(serverEnvSchema.safeParse({ ...required, OPENBOT_AGENT_RUNTIME: value }).success).toBe(
        false,
      );
    }
  });
  it("normalizes local authentication settings", () => {
    const environment = serverEnvSchema.parse({
      ...required,
      OPENBOT_ALLOWED_ORIGINS: "http://localhost:5173, http://127.0.0.1:5173 ",
      OPENBOT_SESSION_TTL_HOURS: "24",
    });

    expect(environment.OPENBOT_ALLOWED_ORIGINS).toEqual([
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]);
    expect(environment.OPENBOT_HOST).toBe("127.0.0.1");
    expect(environment.OPENBOT_SECURE_COOKIES).toBe(false);
    expect(environment.OPENBOT_SESSION_TTL_HOURS).toBe(24);
    expect(environment.OPENBOT_TRUSTED_PROXY_ADDRESS).toBeUndefined();
  });

  it("requires HTTPS and Secure cookies for every remote browser origin", () => {
    expect(
      serverEnvSchema.safeParse({
        ...required,
        OPENBOT_ALLOWED_ORIGINS: "http://openbot.example.test",
        OPENBOT_SECURE_COOKIES: "true",
      }).success,
    ).toBe(false);
    expect(
      serverEnvSchema.safeParse({
        ...required,
        OPENBOT_ALLOWED_ORIGINS: "https://openbot.example.test",
      }).success,
    ).toBe(false);
    expect(
      serverEnvSchema.parse({
        ...required,
        OPENBOT_ALLOWED_ORIGINS: "https://openbot.example.test",
        OPENBOT_SECURE_COOKIES: "true",
      }).OPENBOT_SECURE_COOKIES,
    ).toBe(true);
  });

  it("rejects non-HTTP origins", () => {
    expect(
      serverEnvSchema.safeParse({
        ...required,
        OPENBOT_ALLOWED_ORIGINS: "ftp://localhost",
      }).success,
    ).toBe(false);
  });

  it("rejects a short owner password and an empty origin list", () => {
    expect(
      serverEnvSchema.safeParse({ ...required, OPENBOT_OWNER_PASSWORD: "too-short" }).success,
    ).toBe(false);
    expect(
      serverEnvSchema.safeParse({ ...required, OPENBOT_OWNER_PASSWORD: "fourteen-char!" }).success,
    ).toBe(false);
    expect(serverEnvSchema.safeParse({ ...required, OPENBOT_ALLOWED_ORIGINS: "" }).success).toBe(
      false,
    );
    expect(
      serverEnvSchema.safeParse({
        ...required,
        OPENBOT_OWNER_PASSWORD: "replace-with-a-long-random-owner-password",
      }).success,
    ).toBe(false);
  });

  it("accepts only one exact trusted proxy IP address", () => {
    expect(
      serverEnvSchema.parse({ ...required, OPENBOT_TRUSTED_PROXY_ADDRESS: "2001:db8::1" })
        .OPENBOT_TRUSTED_PROXY_ADDRESS,
    ).toBe("2001:db8::1");
    expect(
      serverEnvSchema.safeParse({ ...required, OPENBOT_TRUSTED_PROXY_ADDRESS: "proxy.example" })
        .success,
    ).toBe(false);
    expect(
      serverEnvSchema.safeParse({ ...required, OPENBOT_TRUSTED_PROXY_ADDRESS: "10.0.0.1,10.0.0.2" })
        .success,
    ).toBe(false);
    expect(
      serverEnvSchema.parse({ ...required, OPENBOT_TRUSTED_PROXY_ADDRESS: "" })
        .OPENBOT_TRUSTED_PROXY_ADDRESS,
    ).toBeUndefined();
  });

  it("requires publisher keyring and passphrase paths together", () => {
    expect(
      serverEnvSchema.safeParse({
        ...required,
        OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH: "./data/publisher",
      }).success,
    ).toBe(false);
    expect(
      serverEnvSchema.safeParse({
        ...required,
        OPENBOT_EMPLOYEE_PUBLISHER_PASSPHRASE_FILE: "./secrets/publisher-passphrase",
      }).success,
    ).toBe(false);
    expect(
      serverEnvSchema.safeParse({
        ...required,
        OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH: "./data/publisher",
        OPENBOT_EMPLOYEE_PUBLISHER_PASSPHRASE_FILE: "./secrets/publisher-passphrase",
      }).success,
    ).toBe(true);
  });
});

describe("node environment", () => {
  it("rejects inherited credentials unless the file profile explicitly opts in", () => {
    const base = { OPENBOT_NODE_ID: "ephemeral-node", OPENBOT_NODE_CREDENTIAL: nodeCredential };
    for (const flag of [undefined, "false", "1", "TRUE", ""]) {
      const result = nodeEnvSchema.safeParse({ ...base, OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: flag });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).not.toContain(nodeCredential);
    }
    const explicit = { ...base, OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: "true" };
    expect(nodeEnvSchema.parse(explicit).OPENBOT_NODE_CREDENTIAL).toBe(nodeCredential);
    for (const store of ["secret-service", "macos-host"]) {
      expect(
        nodeEnvSchema.safeParse({ ...explicit, OPENBOT_NODE_CREDENTIAL_STORE: store }).success,
      ).toBe(false);
    }
    expect(
      nodeEnvSchema.parse({ OPENBOT_NODE_ID: "normal-node" }).OPENBOT_NODE_ALLOW_ENV_CREDENTIAL,
    ).toBe(false);
  });
  it("bounds the advertised concurrency", () => {
    const environment = nodeEnvSchema.parse({
      OPENBOT_NODE_ID: "linux-node",
      OPENBOT_NODE_CREDENTIAL: nodeCredential,
      OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: "true",
      OPENBOT_NODE_MAX_CONCURRENT_RUNS: "2",
    });
    expect(environment.OPENBOT_NODE_MAX_CONCURRENT_RUNS).toBe(2);
    expect(environment.OPENBOT_NODE_CREDENTIAL_STORE).toBe("file");
    expect(environment.OPENBOT_LOG_LEVEL).toBe("info");
    expect(
      nodeEnvSchema.safeParse({
        OPENBOT_NODE_ID: "linux-node",
        OPENBOT_NODE_CREDENTIAL: nodeCredential,
        OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: "true",
        OPENBOT_NODE_MAX_CONCURRENT_RUNS: "17",
      }).success,
    ).toBe(false);
  });

  it("requires an explicit non-file Secret Service configuration", () => {
    expect(
      nodeEnvSchema.parse({
        OPENBOT_NODE_ID: "linux-desktop-node",
        OPENBOT_NODE_ENROLLMENT_TOKEN: enrollmentToken,
        OPENBOT_NODE_CREDENTIAL_STORE: "secret-service",
      }).OPENBOT_NODE_CREDENTIAL_STORE,
    ).toBe("secret-service");
    expect(
      nodeEnvSchema.safeParse({
        OPENBOT_NODE_ID: "linux-desktop-node",
        OPENBOT_NODE_ENROLLMENT_TOKEN: enrollmentToken,
        OPENBOT_NODE_CREDENTIAL_STORE: "secret-service",
        OPENBOT_NODE_CREDENTIAL_PATH: "./identity.json",
      }).success,
    ).toBe(false);
    expect(
      nodeEnvSchema.safeParse({
        OPENBOT_NODE_ID: "linux-desktop-node",
        OPENBOT_NODE_ENROLLMENT_TOKEN: enrollmentToken,
        OPENBOT_NODE_CREDENTIAL_STORE: "automatic",
      }).success,
    ).toBe(false);
  });

  it("reserves macOS Host identity for the private stdio-v3 channel", () => {
    const valid = {
      OPENBOT_NODE_ID: "mac-node",
      OPENBOT_NODE_SERVER_URL: "wss://openbot.example.test/ws/nodes",
      OPENBOT_NODE_CREDENTIAL_STORE: "macos-host",
      OPENBOT_NODE_SERVICE_CONTROL: "stdio-v3",
    };
    expect(nodeEnvSchema.safeParse(valid).success).toBe(true);

    for (const invalid of [
      { ...valid, OPENBOT_NODE_SERVICE_CONTROL: "stdio-v2" },
      { ...valid, OPENBOT_NODE_SERVICE_CONTROL: undefined },
      { ...valid, OPENBOT_NODE_CREDENTIAL: nodeCredential },
      { ...valid, OPENBOT_NODE_ENROLLMENT_TOKEN: enrollmentToken },
      { ...valid, OPENBOT_NODE_CREDENTIAL_PATH: "./identity.json" },
      { ...valid, OPENBOT_NODE_CREDENTIAL_STORE: "file" },
    ]) {
      expect(nodeEnvSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("enables the Docker computer only with a complete credential pair", () => {
    const base = {
      OPENBOT_NODE_ID: "linux-node",
      OPENBOT_NODE_CREDENTIAL: nodeCredential,
      OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: "true",
    };
    expect(
      nodeEnvSchema.safeParse({
        ...base,
        OPENBOT_DOCKER_COMPUTER_URL: "http://127.0.0.1:4100",
      }).success,
    ).toBe(false);
    expect(
      nodeEnvSchema.parse({
        ...base,
        OPENBOT_DOCKER_COMPUTER_URL: "http://127.0.0.1:4100",
        OPENBOT_DOCKER_COMPUTER_TOKEN: "computer-token-for-tests",
        OPENBOT_DOCKER_ALLOW_PRIVATE_HOSTS: "true",
      }).OPENBOT_DOCKER_ALLOW_PRIVATE_HOSTS,
    ).toBe(true);
  });

  it("requires bounded Node identity inputs and WSS off loopback", () => {
    const valid = {
      OPENBOT_NODE_ID: "linux-node:primary",
      OPENBOT_NODE_ENROLLMENT_TOKEN: enrollmentToken,
    };
    expect(nodeEnvSchema.safeParse(valid).success).toBe(true);
    expect(nodeEnvSchema.safeParse({ ...valid, OPENBOT_NODE_ID: "node id" }).success).toBe(false);
    expect(
      nodeEnvSchema.safeParse({ ...valid, OPENBOT_NODE_SERVICE_CONTROL: "stdio-v2" }).success,
    ).toBe(true);
    expect(
      nodeEnvSchema.safeParse({ ...valid, OPENBOT_NODE_SERVICE_CONTROL: "named-pipe" }).success,
    ).toBe(false);
    expect(
      nodeEnvSchema.safeParse({ ...valid, OPENBOT_NODE_ENROLLMENT_TOKEN: "too-short" }).success,
    ).toBe(false);
    expect(
      nodeEnvSchema.safeParse({ ...valid, OPENBOT_NODE_SERVER_URL: "http://localhost:3001" })
        .success,
    ).toBe(false);
    expect(
      nodeEnvSchema.safeParse({ ...valid, OPENBOT_NODE_SERVER_URL: "ws://openbot.example.test" })
        .success,
    ).toBe(false);
    expect(
      nodeEnvSchema.safeParse({ ...valid, OPENBOT_NODE_SERVER_URL: "wss://openbot.example.test" })
        .success,
    ).toBe(true);
  });
});

describe("macOS Node service configuration", () => {
  const valid = {
    format: macOSNodeServiceConfigFormat,
    nodeId: "mac-node:primary",
    serverUrl: "wss://openbot.example.test/ws/nodes",
  };

  it("accepts only the bounded public service fields", () => {
    expect(macOSNodeServiceConfigSchema.parse(valid)).toEqual({
      ...valid,
      maxConcurrentRuns: 1,
      logLevel: "info",
    });
    expect(
      macOSNodeServiceConfigSchema.parse({
        ...valid,
        maxConcurrentRuns: 4,
        logLevel: "warn",
      }),
    ).toMatchObject({ maxConcurrentRuns: 4, logLevel: "warn" });
  });

  it("rejects credentials, paths, providers, unknown versions, and insecure remote URLs", () => {
    for (const invalid of [
      { ...valid, credential: nodeCredential },
      { ...valid, enrollmentToken },
      { ...valid, workDirectory: "/tmp/node" },
      { ...valid, executable: "/usr/local/bin/node" },
      { ...valid, dockerToken: "provider-token" },
      { ...valid, format: "openbot.macos-node-config/v2" },
      { ...valid, serverUrl: "ws://openbot.example.test/ws/nodes" },
      { ...valid, maxConcurrentRuns: 17 },
    ]) {
      expect(macOSNodeServiceConfigSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("browser input opt-in", () => {
  const worker = {
    OPENBOT_NODE_ID: "test-worker",
    OPENBOT_NODE_CREDENTIAL: nodeCredential,
    OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: "true",
  };
  const computer = {
    ...worker,
    OPENBOT_DOCKER_COMPUTER_URL: "http://127.0.0.1:4198",
    OPENBOT_DOCKER_COMPUTER_TOKEN: "isolated-fixture-token",
  };
  it("defaults off and requires a configured computer", () => {
    expect(nodeEnvSchema.parse(worker).OPENBOT_DOCKER_INPUT_ORIGINS).toEqual([]);
    expect(
      nodeEnvSchema.safeParse({ ...worker, OPENBOT_DOCKER_INPUT_ORIGINS: "https://example.test" })
        .success,
    ).toBe(false);
    expect(
      nodeEnvSchema.parse({
        ...computer,
        OPENBOT_DOCKER_INPUT_ORIGINS: "https://example.test,http://127.0.0.1:4197",
      }).OPENBOT_DOCKER_INPUT_ORIGINS,
    ).toHaveLength(2);
  });
  it("rejects user information in an origin", () => {
    const url = new URL("https://example.test");
    url.username = "fixture-user";
    url.password = "fixture-only";
    expect(
      nodeEnvSchema.safeParse({ ...computer, OPENBOT_DOCKER_INPUT_ORIGINS: url.href }).success,
    ).toBe(false);
  });
  it.each(["http://remote.test", "https://example.test/path", "https://example.test/"])(
    "rejects non-exact origins: %s",
    (origin) => {
      expect(
        nodeEnvSchema.safeParse({ ...computer, OPENBOT_DOCKER_INPUT_ORIGINS: origin }).success,
      ).toBe(false);
    },
  );
});
