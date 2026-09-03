import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ObjectStorage, ObjectMetadata } from "./object-storage.js";
import { assertObjectKey } from "./object-storage.js";
import { throwIfAborted } from "../services/abort.js";

export class FakeObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string; etag: string }>();
  readonly operations: string[] = [];
  maxActiveUploads=0; private activeUploads=0;
  async createPresignedUploadUrl({key,contentType,expiresInSeconds}:{key:string;contentType:string;expiresInSeconds:number}) { assertObjectKey(key); return {url:`http://storage.test/${key}?signature=secret`,method:"PUT" as const,headers:{"Content-Type":contentType},expiresAt:new Date(Date.now()+expiresInSeconds*1000).toISOString()}; }
  put(key:string,body:Buffer,contentType="application/octet-stream"){key=assertObjectKey(key);this.objects.set(key,{body,contentType,etag:`etag-${body.length}`});}
  async headObject(key:string):Promise<ObjectMetadata|null>{key=assertObjectKey(key);const o=this.objects.get(key);return o?{key,contentType:o.contentType,contentLength:o.body.length,etag:o.etag}:null;}
  async downloadToFile(key:string,destinationPath:string,signal?:AbortSignal){throwIfAborted(signal);const o=this.objects.get(assertObjectKey(key));if(!o)throw new Error("NotFound");await writeFile(destinationPath,o.body,{flag:"wx"});}
  async uploadFile(input:{key:string;sourcePath:string;contentType:string;signal?:AbortSignal}){throwIfAborted(input.signal);this.activeUploads++;this.maxActiveUploads=Math.max(this.maxActiveUploads,this.activeUploads);try{this.put(input.key,await readFile(input.sourcePath),input.contentType);this.operations.push(`upload:${input.key}`);return (await this.headObject(input.key))!;}finally{this.activeUploads--;}}
  async getObjectStream(key:string){const o=this.objects.get(assertObjectKey(key));if(!o)throw Object.assign(new Error("NotFound"),{code:"NoSuchKey"});return{stream:Readable.from(o.body),contentType:o.contentType,contentLength:o.body.length,etag:o.etag};}
  async copyObject(sourceKey:string,destinationKey:string){const o=this.objects.get(assertObjectKey(sourceKey));if(!o)throw new Error("NotFound");this.put(destinationKey,Buffer.from(o.body),o.contentType);this.operations.push(`copy:${sourceKey}->${destinationKey}`);}
  async deleteObject(key:string){this.objects.delete(assertObjectKey(key));this.operations.push(`delete:${key}`);}
  async deletePrefix(prefix:string){prefix=assertObjectKey(prefix);for(const key of [...this.objects.keys()])if(key.startsWith(prefix))this.objects.delete(key);this.operations.push(`delete-prefix:${prefix}`);}
  async listPrefix(prefix:string){prefix=assertObjectKey(prefix);return Promise.all([...this.objects.keys()].filter(k=>k.startsWith(prefix)).sort().map(k=>this.headObject(k) as Promise<ObjectMetadata>));}
}
