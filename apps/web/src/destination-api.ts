import type { Automation, CreateAutomationInput } from "@openbot/protocol";
import { ApiError } from "./api";

export type { Automation, CreateAutomationInput } from "@openbot/protocol";

export async function listAutomations(signal?: AbortSignal): Promise<Automation[]> {
  const result = await automationRequest<{ automations: Automation[] }>(
    "",
    signal ? { signal } : undefined,
  );
  return result.automations;
}

export async function createAutomation(input: CreateAutomationInput): Promise<Automation> {
  const result = await automationRequest<{ automation: Automation }>("", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.automation;
}

export async function setAutomationEnabled(id: string, enabled: boolean): Promise<Automation> {
  const result = await automationRequest<{ automation: Automation }>(`/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
  return result.automation;
}

export async function deleteAutomation(id: string): Promise<void> {
  await automationRequest(`/${encodeURIComponent(id)}`, { method: "DELETE" });
}

async function automationRequest<T>(suffix: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/automations${suffix}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("openbot:unauthorized"));
    throw new ApiError(`Automation request failed (${response.status}).`, response.status);
  }
  return (await response.json()) as T;
}
