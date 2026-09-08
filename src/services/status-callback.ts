import { loadConfig } from "../config.js";

export async function statusCallback(videoId:string,event:"processing"|"completed"|"failed",body:Record<string,unknown>={}):Promise<void>{const config=loadConfig(),base=config.statusCallbackBaseUrl;if(!base)return;const response=await fetch(`${base}/internal/videos/${videoId}/${event}`,{method:"POST",headers:{"content-type":"application/json","x-worker-secret":config.workerCallbackSecret},body:JSON.stringify(body)});if(!response.ok)throw new Error(`Status callback failed: ${response.status}`);}
