import { hatchet } from "./hatchet-client.js";
import { encodeLimitWarning, loadConfig, loadWorkerConfig } from "./config.js";
import { removeStaleScratch } from "./services/object-processing.js";
import { videoProcessingWorkflow } from "./workflows/video-processing.js";
import { objectVideoWorkflow } from "./workflows/object-video-processing.js";

async function main(): Promise<void> {
  const { workerTempDir, maxConcurrentEncodes } = loadConfig();
  const settings = loadWorkerConfig();
  const encodeWarning = encodeLimitWarning(settings.slots, maxConcurrentEncodes);
  if (encodeWarning) console.warn(encodeWarning);
  // Nothing runs yet, so prefixed scratch directories left in WORKER_TEMP_DIR belong to a previous, interrupted worker.
  const removed = await removeStaleScratch(workerTempDir);
  console.log(`Removed ${removed} stale scratch ${removed === 1 ? "directory" : "directories"} from ${workerTempDir}`);
  const workflows = settings.registerLegacyWorkflow ? [videoProcessingWorkflow, objectVideoWorkflow] : [objectVideoWorkflow];
  const worker = await hatchet.worker("frameflow-worker", {
    workflows,
    slots: settings.slots,
  });
  const running = worker.start();
  await worker.waitUntilReady(30_000);
  const limit = settings.maxConcurrentVideos ? `; at most ${settings.maxConcurrentVideos} video${settings.maxConcurrentVideos === 1 ? "" : "s"} at a time` : "";
  console.log(`Hatchet worker registered with ${settings.slots} slots (${workflows.map((workflow) => workflow.name).join(", ")}${limit}); waiting for Frameflow work`);
  await running;
}

main().catch((error: unknown) => {
  console.error("Worker failed:", error);
  process.exitCode = 1;
});
