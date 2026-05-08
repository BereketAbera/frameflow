import { videoProcessingWorkflow, type VideoProcessingInput } from "../workflows/video-processing.js";

export interface WorkflowSubmitter {
  submit(input: VideoProcessingInput): Promise<{ runId: string }>;
}

export class HatchetWorkflowSubmitter implements WorkflowSubmitter {
  async submit(input: VideoProcessingInput): Promise<{ runId: string }> {
    const run = await videoProcessingWorkflow.runNoWait(input, {
      additionalMetadata: { videoId: input.videoId },
    });
    return { runId: await run.getWorkflowRunId() };
  }
}
