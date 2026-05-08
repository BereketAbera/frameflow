import "dotenv/config";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { markCompletedTask, videoProcessingWorkflow, type VideoProcessingResult } from "./workflows/video-processing.js";

async function main(): Promise<void> {
  const argument = process.argv[2];
  if (!argument) throw new Error("Usage: npm run process -- ./input/sample.mp4");
  const sourcePath = path.resolve(argument);
  const info = await stat(sourcePath);
  if (!info.isFile()) throw new Error(`Input is not a regular file: ${sourcePath}`);
  if (path.extname(sourcePath).toLowerCase() !== ".mp4") throw new Error("Phase 1 accepts MP4 files only");

  const videoId = process.env.VIDEO_ID?.trim() || randomUUID();
  const outputBasePath = path.resolve("output");
  const force720pFailureOnce = /^(1|true|yes)$/i.test(process.env.FORCE_720P_FAILURE_ONCE ?? "");
  const run = await videoProcessingWorkflow.runNoWait({ sourcePath, videoId, outputBasePath, force720pFailureOnce });
  console.log(`Workflow run ID: ${run.workflowRunId}`);
  console.log("Waiting for completion...");
  const output = await run.result() as Record<string, unknown>;
  const result = output[markCompletedTask.name] as VideoProcessingResult | undefined;
  if (!result || result.status !== "completed") throw new Error("Workflow completed without a valid mark-completed result");
  console.log(JSON.stringify(result, null, 2));
  console.log(`Master playlist: ${result.masterPlaylistPath}`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error("Trigger failed:", error);
    process.exit(1);
  },
);
