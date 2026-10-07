import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["conformance/*-contract.acceptance.ts"], environment: "jsdom" },
});
