import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));

export async function migrateDatabase(databasePath: string): Promise<void> {
  await mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const migrations = [
      { version: 1, file: "001_create_videos.sql" },
      { version: 2, file: "002_object_storage.sql" },
      { version: 3, file: "003_video_ownership.sql" },
      { version: 4, file: "004_social_platform.sql" },
      { version: 5, file: "005_featured_ai_videos.sql" },
    ];
    const applied = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
    for (const migration of migrations) {
      if (applied.get(migration.version)) continue;
      const sql = await readFile(path.join(migrationsDirectory, migration.file), "utf8");
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(sql);
        database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  } finally {
    database.close();
  }
}
