import type { NodeEnv } from "@openbot/config";
import { createDockerProvider } from "@openbot/provider-docker";
import type { ComputerProvider } from "@openbot/provider-sdk";
import type { NodeCapability, NodeCapabilityDescriptor } from "@openbot/protocol";
import { detectWorkerHost } from "./host.js";

export function configuredProviders(env: NodeEnv): ComputerProvider[] {
  const providers: ComputerProvider[] = [];
  if (
    env.OPENBOT_DOCKER_COMPUTER_URL !== undefined &&
    env.OPENBOT_DOCKER_COMPUTER_TOKEN !== undefined
  ) {
    providers.push(
      createDockerProvider({
        computerUrl: env.OPENBOT_DOCKER_COMPUTER_URL,
        computerToken: env.OPENBOT_DOCKER_COMPUTER_TOKEN,
        allowPrivateHosts: env.OPENBOT_DOCKER_ALLOW_PRIVATE_HOSTS,
        inputOrigins: env.OPENBOT_DOCKER_INPUT_ORIGINS,
        enableBrowserSessions: env.OPENBOT_DOCKER_BROWSER_SESSIONS,
      }),
    );
  }
  const currentPlatform = detectWorkerHost().platform;
  return providers.filter((provider) => provider.platforms.includes(currentPlatform));
}

export function availableCapabilities(providers: ComputerProvider[]): NodeCapability[] {
  return Array.from(
    new Set(
      providers
        .filter((provider) => provider.execute !== undefined)
        .flatMap((provider) => provider.capabilities),
    ),
  ).sort();
}

export function availableCapabilityManifest(
  providers: ComputerProvider[],
): NodeCapabilityDescriptor[] {
  const descriptors = new Map<string, NodeCapabilityDescriptor>();
  for (const descriptor of providers
    .filter((provider) => provider.execute !== undefined)
    .flatMap((provider) => provider.capabilityManifest)) {
    const key = `${descriptor.id}@${descriptor.version}:${descriptor.providerId}`;
    descriptors.set(key, descriptor);
  }
  return Array.from(descriptors.values()).sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.version - right.version ||
      left.providerId.localeCompare(right.providerId),
  );
}

export function providerForProfile(
  providers: ComputerProvider[],
  profile: "docker-linux" | "macos-cua" | "lume-vm" | "coder",
): ComputerProvider | undefined {
  const providerIds = {
    "docker-linux": "docker",
    "macos-cua": "cua",
    "lume-vm": "lume",
    coder: "coder",
  } as const;
  const providerId = providerIds[profile];
  return providers.find((provider) => provider.id === providerId && provider.execute !== undefined);
}
