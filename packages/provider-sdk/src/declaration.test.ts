import { describe, expect, it } from "vitest";
import { assertProviderDeclarations, inspectProviderDeclaration } from "./declaration.js";
import type { ComputerProvider } from "./provider.js";

const provider = (): ComputerProvider => ({
  id: "demo",
  displayName: "Demo",
  platforms: ["linux"],
  capabilities: ["browser"],
  capabilityManifest: [{ id: "browser.observe", version: 1, providerId: "demo", constraints: {} }],
});

describe("Provider declaration wire validation", () => {
  it.each([0, -1, 1.5, 101, Number.NaN])(
    "rejects wire-invalid capability version %s before advertising",
    (version) => {
      const input = provider();
      input.capabilityManifest = input.capabilityManifest.map((item) => ({ ...item, version }));
      expect(inspectProviderDeclaration(input)).toMatchObject({
        conformant: false,
        issues: [{ code: "capability-invalid" }],
      });
      expect(() => assertProviderDeclarations([input])).toThrow("capability-invalid");
    },
  );
  it("rejects invalid constraints, capability names and platforms through the shared schema", () => {
    const base = provider();
    const descriptor = base.capabilityManifest[0];
    if (!descriptor) throw new Error("Fixture requires a capability descriptor.");
    const invalid = [
      {
        ...base,
        capabilityManifest: [
          {
            ...descriptor,
            constraints: Object.fromEntries(
              Array.from({ length: 17 }, (_, i) => [`key${i}`, true]),
            ),
          },
        ],
      },
      { ...base, capabilityManifest: [{ ...descriptor, id: "undeclared.execute" }] },
      { ...base, capabilities: ["undeclared"] },
      { ...base, platforms: ["unrecognized-os"] },
    ];
    for (const input of invalid)
      expect(inspectProviderDeclaration(input as ComputerProvider).conformant).toBe(false);
    expect(inspectProviderDeclaration(base).conformant).toBe(true);
  });
});
