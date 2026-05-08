import "dotenv/config";
import { loadConfig } from "./config.js";
import { migrateDatabase } from "./db/migrate.js";

const config = loadConfig();
migrateDatabase(config.databasePath).then(
  () => console.log(`Database initialized: ${config.databasePath}`),
  (error: unknown) => { console.error("Database initialization failed:", error); process.exitCode = 1; },
);
