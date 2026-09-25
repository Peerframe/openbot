// Only the existing reviewed migrator runs here; no TypeScript business Server is started.
import { createDatabase } from "../packages/db/dist/index.js";

const database = createDatabase(process.env.OPENBOT_DATABASE_URL);
try {
  await database.migrate();
} finally {
  await database.close();
}
