import { objectVideoWorkflow, type ObjectVideoWorkflowInput } from "../workflows/object-video-processing.js";

export interface WorkflowSubmitter {
  submit(input: ObjectVideoWorkflowInput): Promise<{ runId: string }>;
}

export class HatchetWorkflowSubmitter implements WorkflowSubmitter {
  async submit(input: ObjectVideoWorkflowInput): Promise<{ runId: string }> {
    const run = await objectVideoWorkflow.runNoWait(input, {
      additionalMetadata: { videoId: input.videoId },
    });
    return { runId: await run.getWorkflowRunId() };
  }
}
