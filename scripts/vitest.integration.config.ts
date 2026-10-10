/** Serial owned service scenarios; each test closes its processes, databases and temporary files. */
import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["scripts/*.integration.test.ts"],
  fileParallelism: false, testTimeout: 480000, hookTimeout: 120000,
} });
