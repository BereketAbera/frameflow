import "dotenv/config";
import { loadConfig } from "./config.js";
import { migrateDatabase } from "./db/migrate.js";
import { VideoRepository } from "./db/video-repository.js";
import { HatchetRunInspector, reconcileVideos } from "./services/reconciliation.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await migrateDatabase(config.databasePath);
  const repository = new VideoRepository(config.databasePath);
  try {
    const staleBefore = new Date(Date.now() - config.reconciliationStaleMinutes * 60_000).toISOString();
    const result = await reconcileVideos({
      repository, inspector: new HatchetRunInspector(), outputDir: config.outputDir,
      staleBefore, log: console.log,
    });
    console.log(`Reconciliation complete: inspected=${result.inspected}, repaired=${result.repaired}`);
  } finally { repository.close(); }
}

main().catch((error: unknown) => { console.error("Reconciliation failed:", error); process.exitCode = 1; });
