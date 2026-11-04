import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hatchet } from "../hatchet-client.js";
import { encodeRendition, generateMasterPlaylist, probeVideo } from "../services/ffmpeg.js";
import { encodingSemaphore } from "../services/encoding-semaphore.js";
import { markWorkflowCompleted, markWorkflowFailed, markWorkflowProcessing } from "../services/status-projection.js";

export type VideoProcessingInput = {
  sourcePath: string;
  videoId: string;
  outputBasePath: string;
  force720pFailureOnce?: boolean;
  databasePath?: string;
};

export type ValidatedInput = VideoProcessingInput & { outputPath: string };

export type VideoProcessingResult = {
  videoId: string;
  status: "completed";
  masterPlaylistPath: string;
  renditions: Array<{ name: "360p" | "720p"; playlistPath: string }>;
};

const inputSchema = z.object({
  sourcePath: z.string().min(1),
  videoId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  outputBasePath: z.string().min(1),
  force720pFailureOnce: z.boolean().optional(),
  databasePath: z.string().min(1).optional(),
});

export const videoProcessingWorkflow = hatchet.workflow<VideoProcessingInput>({
  name: "frameflow-phase-2",
  inputValidator: inputSchema,
  idempotency: { strategy: "status", expression: "input.videoId", fallbackTtlMs: 86_400_000 },
});

export const validateInputTask = videoProcessingWorkflow.task({
  name: "validate-input",
  retries: 0,
  fn: async (input, ctx): Promise<ValidatedInput> => {
    await ctx.log(`Validating video ${input.videoId}`);
    markWorkflowProcessing(input.databasePath, input.videoId);
    const sourcePath = await realpath(input.sourcePath);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) throw new Error(`Input is not a regular file: ${sourcePath}`);
    if (path.extname(sourcePath).toLowerCase() !== ".mp4") throw new Error("Phase 1 accepts MP4 files only");
    const outputBasePath = path.resolve(input.outputBasePath);
    const outputPath = path.join(outputBasePath, input.videoId);
    await mkdir(outputPath, { recursive: true });
    await ctx.log(`Validated ${sourcePath}; output will be ${outputPath}`);
    return { ...input, sourcePath, outputBasePath, outputPath };
  },
});

export const probeVideoTask = videoProcessingWorkflow.task({
  name: "probe-video",
  parents: [validateInputTask],
  retries: 2,
  backoff: { factor: 2, maxSeconds: 10 },
  fn: async (_input, ctx) => {
    const validated = await ctx.parentOutput(validateInputTask);
    await ctx.log(`Probing video ${validated.videoId}`);
    const metadata = await probeVideo(validated.sourcePath, (message) => ctx.log(`[ffprobe] ${message}`));
    await ctx.log(`Probe complete: ${JSON.stringify(metadata)}`);
    return { ...validated, metadata };
  },
});

export const encode360pTask = videoProcessingWorkflow.task({
  name: "encode-360p",
  parents: [probeVideoTask],
  retries: 2,
  backoff: { factor: 2, maxSeconds: 15 },
  executionTimeout: "30m",
  fn: async (_input, ctx) => {
    const probed = await ctx.parentOutput(probeVideoTask);
    await ctx.log(`Starting 360p encode for ${probed.videoId}`);
    const rendition = await encodingSemaphore.run(() => encodeRendition({
      inputPath: probed.sourcePath, outputRoot: probed.outputPath, rendition: "360p",
      hasAudio: probed.metadata.hasAudio, log: (message) => ctx.log(`[ffmpeg 360p] ${message}`),
    }));
    await ctx.log(`Completed 360p encode for ${probed.videoId}`);
    return { videoId: probed.videoId, ...rendition };
  },
});

export const encode720pTask = videoProcessingWorkflow.task({
  name: "encode-720p",
  parents: [probeVideoTask],
  retries: 2,
  backoff: { factor: 2, maxSeconds: 15 },
  executionTimeout: "30m",
  fn: async (_input, ctx) => {
    const probed = await ctx.parentOutput(probeVideoTask);
    await ctx.log(`Starting 720p encode for ${probed.videoId}; retry=${ctx.retryCount()}`);
    if (probed.force720pFailureOnce && ctx.retryCount() === 0) {
      await ctx.log("Development retry demo: forcing first 720p attempt to fail", "WARN");
      throw new Error("Intentional one-time 720p failure for retry demonstration");
    }
    const rendition = await encodingSemaphore.run(() => encodeRendition({
      inputPath: probed.sourcePath, outputRoot: probed.outputPath, rendition: "720p",
      hasAudio: probed.metadata.hasAudio, log: (message) => ctx.log(`[ffmpeg 720p] ${message}`),
    }));
    await ctx.log(`Completed 720p encode for ${probed.videoId}`);
    return { videoId: probed.videoId, ...rendition };
  },
});

export const generateMasterPlaylistTask = videoProcessingWorkflow.task({
  name: "generate-master-playlist",
  parents: [encode360pTask, encode720pTask],
  retries: 1,
  fn: async (_input, ctx) => {
    const rendition360p = await ctx.parentOutput(encode360pTask);
    const rendition720p = await ctx.parentOutput(encode720pTask);
    const outputPath = path.dirname(rendition360p.playlistPath);
    const masterPlaylistPath = await generateMasterPlaylist(path.dirname(outputPath), [rendition360p, rendition720p]);
    await ctx.log(`Published master playlist for ${rendition360p.videoId}: ${masterPlaylistPath}`);
    return { videoId: rendition360p.videoId, masterPlaylistPath, renditions: [rendition360p, rendition720p] };
  },
});

export const markCompletedTask = videoProcessingWorkflow.task({
  name: "mark-completed",
  parents: [generateMasterPlaylistTask],
  fn: async (_input, ctx): Promise<VideoProcessingResult> => {
    const generated = await ctx.parentOutput(generateMasterPlaylistTask);
    const result: VideoProcessingResult = {
      videoId: generated.videoId,
      status: "completed",
      masterPlaylistPath: generated.masterPlaylistPath,
      renditions: generated.renditions.map(({ name, playlistPath }) => ({ name, playlistPath })),
    };
    const input = _input as VideoProcessingInput;
    markWorkflowCompleted(input.databasePath, result.videoId, result.masterPlaylistPath);
    await ctx.log(`Video ${result.videoId} completed`);
    return result;
  },
});

videoProcessingWorkflow.onFailure({
  name: "mark-failed",
  retries: 2,
  backoff: { factor: 2, maxSeconds: 10 },
  fn: async (input, ctx) => {
    const errors = ctx.errors();
    markWorkflowFailed(input.databasePath, input.videoId, errors);
    await ctx.log(`Video ${input.videoId} reached a terminal failure`);
    return { videoId: input.videoId, status: "failed" as const };
  },
});
