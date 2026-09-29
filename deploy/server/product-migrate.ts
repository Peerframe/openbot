const url = process.env.OPENBOT_DATABASE_URL;
if (!url) throw new Error("Product migration database URL is missing.");
const { createDatabase } = await import("../../packages/db/dist/index.js");
const database = createDatabase(url);
try {
  await database.migrate();
} finally {
  await database.close();
}
