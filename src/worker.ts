import { hatchet } from "./hatchet-client.js";
import { videoProcessingWorkflow } from "./workflows/video-processing.js";
import { objectVideoWorkflow } from "./workflows/object-video-processing.js";

async function main(): Promise<void> {
  const worker = await hatchet.worker("frameflow-worker", {
    workflows: [videoProcessingWorkflow, objectVideoWorkflow],
    slots: 2,
  });
  const running = worker.start();
  await worker.waitUntilReady(30_000);
  console.log("Hatchet worker registered with 2 slots; waiting for Frameflow work");
  await running;
}

main().catch((error: unknown) => {
  console.error("Worker failed:", error);
  process.exitCode = 1;
});
