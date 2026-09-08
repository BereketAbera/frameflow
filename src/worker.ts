import { hatchet } from "./hatchet-client.js";
import { videoProcessingWorkflow } from "./workflows/video-processing.js";

async function main(): Promise<void> {
  const worker = await hatchet.worker("video-processing-poc-worker", {
    workflows: [videoProcessingWorkflow],
    slots: 2,
  });
  const running = worker.start();
  await worker.waitUntilReady(30_000);
  console.log("Hatchet worker registered with 2 slots; waiting for video-processing work");
  await running;
}

main().catch((error: unknown) => {
  console.error("Worker failed:", error);
  process.exitCode = 1;
});
