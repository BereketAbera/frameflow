import { z } from "zod";
import type { Duration } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { hatchet } from "../hatchet-client.js";
import { loadConfig, loadWorkerConfig } from "../config.js";
import { createObjectStorage } from "../storage/create-storage.js";
import { encodeObjectRendition, probeObject, publishRenditions } from "../services/object-processing.js";
import { encodingSemaphore } from "../services/encoding-semaphore.js";
import { sanitizeWorkflowFailure } from "../services/status-projection.js";
import { statusCallback } from "../services/status-callback.js";
export type ObjectVideoWorkflowInput={videoId:string;sourceObjectKey:string;outputPrefix:string;force720pFailureOnce?:boolean};
const schema=z.object({videoId:z.string().regex(/^[\w-]+$/),sourceObjectKey:z.string(),outputPrefix:z.string(),force720pFailureOnce:z.boolean().optional()});
// Every task states its execution timeout (Hatchet defaults to 60s) and a generous schedule timeout (default 5m), so large sources
// and runs waiting behind other videos are not failed early. loadWorkerConfig validates the Go-style duration.
const scheduleTimeout=loadWorkerConfig().scheduleTimeout as Duration;
export const objectVideoWorkflow=hatchet.workflow<ObjectVideoWorkflowInput>({name:"frameflow-phase-3",inputValidator:schema,idempotency:{strategy:"status",expression:"input.videoId",fallbackTtlMs:86_400_000}});
const validate=objectVideoWorkflow.task({name:"validate-object",executionTimeout:"2m",scheduleTimeout,fn:async(input,ctx)=>{await statusCallback(input.videoId,"processing");const object=await createObjectStorage().headObject(input.sourceObjectKey);if(!object)throw new Error("Source object missing");return input;}});
const probe=objectVideoWorkflow.task({name:"probe-object",parents:[validate],retries:2,executionTimeout:"15m",scheduleTimeout,fn:async(input)=>({...input,metadata:await probeObject(createObjectStorage(),input.sourceObjectKey,loadConfig().workerTempDir)})});
const e360=objectVideoWorkflow.task({name:"encode-360p",parents:[probe],retries:2,executionTimeout:"30m",scheduleTimeout,fn:async(input,ctx)=>{const p=await ctx.parentOutput(probe);return encodingSemaphore.run(()=>encodeObjectRendition({storage:createObjectStorage(),sourceKey:input.sourceObjectKey,stagingPrefix:`videos/${input.videoId}/staging/${ctx.workflowRunId()}`,rendition:"360p",hasAudio:p.metadata.hasAudio,scratchRoot:loadConfig().workerTempDir}));}});
const e720=objectVideoWorkflow.task({name:"encode-720p",parents:[probe],retries:2,executionTimeout:"30m",scheduleTimeout,fn:async(input,ctx)=>{const p=await ctx.parentOutput(probe);if(input.force720pFailureOnce&&ctx.retryCount()===0)throw new Error("Intentional one-time 720p failure for retry demonstration");return encodingSemaphore.run(()=>encodeObjectRendition({storage:createObjectStorage(),sourceKey:input.sourceObjectKey,stagingPrefix:`videos/${input.videoId}/staging/${ctx.workflowRunId()}`,rendition:"720p",hasAudio:p.metadata.hasAudio,scratchRoot:loadConfig().workerTempDir}));}});
const publish=objectVideoWorkflow.task({name:"publish",parents:[e360,e720],retries:2,executionTimeout:"15m",scheduleTimeout,fn:async(input,ctx)=>{const a=await ctx.parentOutput(e360),b=await ctx.parentOutput(e720);const masterPlaylistObjectKey=await publishRenditions({storage:createObjectStorage(),videoId:input.videoId,stagingPrefix:a.stagingPrefix,publishedPrefix:input.outputPrefix,renditions:[a,b],scratchRoot:loadConfig().workerTempDir});return{videoId:input.videoId,masterPlaylistObjectKey};}});
objectVideoWorkflow.task({name:"complete",parents:[publish],executionTimeout:"2m",scheduleTimeout,fn:async(input,ctx)=>{const result=await ctx.parentOutput(publish);await statusCallback(input.videoId,"completed",result);return{...result,status:"completed" as const};}});
objectVideoWorkflow.onFailure({name:"fail",retries:2,executionTimeout:"2m",scheduleTimeout,fn:async(input,ctx)=>{await statusCallback(input.videoId,"failed",sanitizeWorkflowFailure(ctx.errors()));return{status:"failed" as const};}});
