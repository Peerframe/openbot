// The explicit TS candidate shares the container's validated SQL/Temporal upgrade preflight.

import { desktopStartupExitCode, reportFailure } from "../apps/server/dist/logging.js";
import { prepareProduct } from "../deploy/server/prepare-product.ts";

try {
  await prepareProduct(process.env);
} catch (error) {
  reportFailure("desktop-preflight", error);
  process.exitCode = desktopStartupExitCode(error);
}
