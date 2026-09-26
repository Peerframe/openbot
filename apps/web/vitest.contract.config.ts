import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["conformance/work-contract.acceptance.ts"], environment: "jsdom" },
});
