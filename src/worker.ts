import { hatchet } from "./hatchet-client.js";
import { loadWorkerConfig } from "./config.js";
import { videoProcessingWorkflow } from "./workflows/video-processing.js";
import { objectVideoWorkflow } from "./workflows/object-video-processing.js";

async function main(): Promise<void> {
  const settings = loadWorkerConfig();
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
