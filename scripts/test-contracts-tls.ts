/** Keeps the named HTTPS CI entry and its isolated trust anchor. */
import { runContractSuites } from "./contract-suite-runner.ts";
await runContractSuites(true, process.argv.slice(2));
