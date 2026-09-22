import { createBrowserSuite } from "./scenarios.mjs";

// Only the dedicated driver supplies this disposable database; never read a developer's .env.
export const suite = createBrowserSuite(process.env.OPENBOT_CONFORMANCE_DATABASE_URL);
