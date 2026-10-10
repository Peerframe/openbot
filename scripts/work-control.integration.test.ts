/** Real PostgreSQL/mTLS Temporal control and process death, using owned service lifetimes. */
import { afterAll, beforeAll, describe, it } from "vitest";
import { startTemporalFixture } from "./temporal-fixture.ts";
import { qualifyWorkControl } from "./integration/work-control.ts";
let temporal: Awaited<ReturnType<typeof startTemporalFixture>>;
beforeAll(async () => { temporal = await startTemporalFixture(); });
afterAll(async () => { await temporal?.close(); });
describe("Work recovery authority", () => {
  for (const mode of ["drain", "control", "recovery"] as const)
    it(mode, async () => qualifyWorkControl(temporal.settings, mode));
});
