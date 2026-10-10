/** Public black-box consumers retain real HTTP, SQL, MCP and artifact byte assertions. */
import { describe, it } from "vitest";
import { runHttpContracts } from "./http-contracts.ts";

describe("complete Server public contracts", () => {
  for (const suite of ["all", "models", "publisher"])
    it(suite, async () => runHttpContracts(suite, process.env.OPENBOT_CONTRACT_TLS_DIRECTORY));
});
