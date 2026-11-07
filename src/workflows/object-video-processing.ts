import { z } from "zod";
import { ConcurrencyLimitStrategy, type Duration } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { hatchet } from "../hatchet-client.js";
import { loadConfig, loadWorkerConfig } from "../config.js";
import { createObjectStorage } from "../storage/create-storage.js";
import { encodeObjectRendition, probeObject, publishRenditions } from "../services/object-processing.js";
import { encodingSemaphore } from "../services/encoding-semaphore.js";
import { sanitizeWorkflowFailure } from "../services/status-projection.js";
import { statusCallback } from "../services/status-callback.js";
export type ObjectVideoWorkflowInput={videoId:string;sourceObjectKey:string;outputPrefix:string;force720pFailureOnce?:boolean};
const schema=z.object({videoId:z.string().regex(/^[\w-]+$/),sourceObjectKey:z.string(),outputPrefix:z.string(),force720pFailureOnce:z.boolean().optional()});
// Every task states its execution timeout (Hatchet would default to 60s) and a generous schedule timeout (Hatchet would default to 5m),
// so large sources and runs waiting behind other videos are not failed early. loadWorkerConfig validates the Go-style duration.
// ctx.abortController.signal fires when a run is cancelled or a task exceeds its execution timeout; it stops FFmpeg and transfers.
const settings=loadWorkerConfig(),scheduleTimeout=settings.scheduleTimeout as Duration;
// FRAMEFLOW_MAX_CONCURRENT_VIDEOS caps whole runs. A constant key puts every video in one group, and GROUP_ROUND_ROBIN queues runs beyond
// maxRuns until one finishes; the default CANCEL_IN_PROGRESS would cancel them instead. The array form registers as concurrencyArr.
const concurrency=settings.maxConcurrentVideos?[{expression:"'frameflow'",maxRuns:settings.maxConcurrentVideos,limitStrategy:ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN}]:undefined;
export const objectVideoWorkflow=hatchet.workflow<ObjectVideoWorkflowInput>({name:"frameflow-phase-3",inputValidator:schema,idempotency:{strategy:"status",expression:"input.videoId",fallbackTtlMs:86_400_000},...(concurrency?{concurrency}:{})});
const validate=objectVideoWorkflow.task({name:"validate-object",executionTimeout:"2m",scheduleTimeout,fn:async(input,ctx)=>{await statusCallback(input.videoId,"processing");const object=await createObjectStorage().headObject(input.sourceObjectKey);if(!object)throw new Error("Source object missing");return input;}});
const probe=objectVideoWorkflow.task({name:"probe-object",parents:[validate],retries:2,executionTimeout:"15m",scheduleTimeout,fn:async(input,ctx)=>({...input,metadata:await probeObject(createObjectStorage(),input.sourceObjectKey,loadConfig().workerTempDir,ctx.abortController.signal)})});
const e360=objectVideoWorkflow.task({name:"encode-360p",parents:[probe],retries:2,executionTimeout:"30m",scheduleTimeout,fn:async(input,ctx)=>{const p=await ctx.parentOutput(probe),signal=ctx.abortController.signal;return encodingSemaphore.run(()=>encodeObjectRendition({storage:createObjectStorage(),sourceKey:input.sourceObjectKey,stagingPrefix:`videos/${input.videoId}/staging/${ctx.workflowRunId()}`,rendition:"360p",hasAudio:p.metadata.hasAudio,scratchRoot:loadConfig().workerTempDir,signal,ffmpeg:settings.ffmpeg}),signal);}});
const e720=objectVideoWorkflow.task({name:"encode-720p",parents:[probe],retries:2,executionTimeout:"30m",scheduleTimeout,fn:async(input,ctx)=>{const p=await ctx.parentOutput(probe),signal=ctx.abortController.signal;if(input.force720pFailureOnce&&ctx.retryCount()===0)throw new Error("Intentional one-time 720p failure for retry demonstration");return encodingSemaphore.run(()=>encodeObjectRendition({storage:createObjectStorage(),sourceKey:input.sourceObjectKey,stagingPrefix:`videos/${input.videoId}/staging/${ctx.workflowRunId()}`,rendition:"720p",hasAudio:p.metadata.hasAudio,scratchRoot:loadConfig().workerTempDir,signal,ffmpeg:settings.ffmpeg}),signal);}});
const publish=objectVideoWorkflow.task({name:"publish",parents:[e360,e720],retries:2,executionTimeout:"15m",scheduleTimeout,fn:async(input,ctx)=>{const a=await ctx.parentOutput(e360),b=await ctx.parentOutput(e720);const masterPlaylistObjectKey=await publishRenditions({storage:createObjectStorage(),videoId:input.videoId,stagingPrefix:a.stagingPrefix,publishedPrefix:input.outputPrefix,renditions:[a,b],scratchRoot:loadConfig().workerTempDir,signal:ctx.abortController.signal});return{videoId:input.videoId,masterPlaylistObjectKey};}});
objectVideoWorkflow.task({name:"complete",parents:[publish],executionTimeout:"2m",scheduleTimeout,fn:async(input,ctx)=>{const result=await ctx.parentOutput(publish);await statusCallback(input.videoId,"completed",result);return{...result,status:"completed" as const};}});
objectVideoWorkflow.onFailure({name:"fail",retries:2,executionTimeout:"2m",scheduleTimeout,fn:async(input,ctx)=>{await statusCallback(input.videoId,"failed",sanitizeWorkflowFailure(ctx.errors()));return{status:"failed" as const};}});
