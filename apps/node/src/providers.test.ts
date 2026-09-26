import { nodeEnvSchema } from "@openbot/config";
import { coderProvider } from "@openbot/provider-coder";
import { cuaProvider } from "@openbot/provider-cua";
import { lumeProvider } from "@openbot/provider-lume";
import { inspectProviderDeclaration } from "@openbot/provider-sdk";
import { describe, expect, it } from "vitest";
import {
  availableCapabilities,
  availableCapabilityManifest,
  configuredProviders,
  providerForProfile,
} from "./providers.js";

const baseEnv = {
  OPENBOT_NODE_ID: "test-node",
  OPENBOT_NODE_SERVER_URL: "ws://127.0.0.1:3001/ws/nodes",
};

describe("configured Node providers", () => {
  it("advertises no executable capabilities without a configured computer", () => {
    const providers = configuredProviders(nodeEnvSchema.parse(baseEnv));

    expect(providers).toEqual([]);
    expect(availableCapabilities(providers)).toEqual([]);
    expect(availableCapabilityManifest(providers)).toEqual([]);
  });

  it("advertises only the configured Docker computer capabilities", () => {
    const providers = configuredProviders(
      nodeEnvSchema.parse({
        ...baseEnv,
        OPENBOT_DOCKER_COMPUTER_URL: "http://127.0.0.1:8080",
        OPENBOT_DOCKER_COMPUTER_TOKEN: "0123456789abcdef",
      }),
    );

    expect(providers.map((provider) => provider.id)).toEqual(["docker"]);
    expect(availableCapabilities(providers)).toEqual(["browser", "screenshot"]);
    expect(availableCapabilityManifest(providers).map((item) => item.id)).toEqual([
      "browser.observe",
      "screen.capture",
    ]);
    expect(providerForProfile(providers, "docker-linux")?.id).toBe("docker");
    expect(providerForProfile(providers, "macos-cua")).toBeUndefined();
  });

  it("does not advertise declarations that cannot execute", () => {
    const declarations = [
      {
        id: "cua",
        displayName: "Cua declaration",
        platforms: ["macos" as const],
        capabilities: ["cua" as const, "screenshot" as const],
        capabilityManifest: [
          { id: "desktop.observe" as const, version: 1, providerId: "cua", constraints: {} },
        ],
      },
    ];

    expect(availableCapabilities(declarations)).toEqual([]);
    expect(availableCapabilityManifest(declarations)).toEqual([]);
  });

  it("enables browser sessions only with an explicit configured computer opt-in", () => {
    expect(
      nodeEnvSchema.safeParse({ ...baseEnv, OPENBOT_DOCKER_BROWSER_SESSIONS: "true" }).success,
    ).toBe(false);
    const providers = configuredProviders(
      nodeEnvSchema.parse({
        ...baseEnv,
        OPENBOT_DOCKER_COMPUTER_URL: "http://127.0.0.1:8080",
        OPENBOT_DOCKER_COMPUTER_TOKEN: "0123456789abcdef",
        OPENBOT_DOCKER_BROWSER_SESSIONS: "true",
      }),
    );
    expect(availableCapabilityManifest(providers).map((item) => item.id)).toContain(
      "browser.session",
    );
  });

  it("keeps unfinished built-in Provider packages conformant but declaration-only", () => {
    for (const provider of [cuaProvider, lumeProvider, coderProvider]) {
      expect(inspectProviderDeclaration(provider)).toMatchObject({
        providerId: provider.id,
        conformant: true,
        executionStatus: "declaration-only",
        issues: [],
      });
    }
  });

  it("requires both session and trusted-origin opt-in for page tasks", () => {
    const configured = {
      ...baseEnv,
      OPENBOT_DOCKER_COMPUTER_URL: "http://127.0.0.1:8080",
      OPENBOT_DOCKER_COMPUTER_TOKEN: "0123456789abcdef",
      OPENBOT_DOCKER_BROWSER_TASKS: "true",
    };
    expect(nodeEnvSchema.safeParse(configured).success).toBe(false);
    expect(
      nodeEnvSchema.safeParse({ ...configured, OPENBOT_DOCKER_BROWSER_SESSIONS: "true" }).success,
    ).toBe(false);
    const providers = configuredProviders(
      nodeEnvSchema.parse({
        ...configured,
        OPENBOT_DOCKER_BROWSER_SESSIONS: "true",
        OPENBOT_DOCKER_INPUT_ORIGINS: "https://synthetic.invalid",
      }),
    );
    expect(providers[0]?.browserTask).toBeTypeOf("function");
    expect(availableCapabilityManifest(providers).map((item) => item.id)).toContain("browser.page");
  });
});
