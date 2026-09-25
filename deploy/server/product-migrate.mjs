// Retained Drizzle advisory-lock and exact-history migrator; no business Server entry.
import { createDatabase } from "../../packages/db/dist/index.js";
const database = createDatabase(process.env.OPENBOT_DATABASE_URL);
try {
  await database.migrate();
} finally {
  await database.close();
}
