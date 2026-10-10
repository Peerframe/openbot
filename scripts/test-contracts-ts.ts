/** Keeps each named HTTP CI gate while executing the migrated Vitest consumer. */
import { runContractSuites } from "./contract-suite-runner.ts";
await runContractSuites(false, process.argv.slice(2));
