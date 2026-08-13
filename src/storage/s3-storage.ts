import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage, ObjectMetadata } from "./object-storage.js";
import { assertObjectKey } from "./object-storage.js";

export type S3StorageConfig = { endpoint?: string; publicEndpoint?: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean };

export class S3ObjectStorage implements ObjectStorage {
  readonly client: S3Client;
  private publicClient?: S3Client;
  constructor(private readonly config: S3StorageConfig) {
    if (!config.bucket || !config.region || !config.accessKeyId || !config.secretAccessKey) throw new Error("S3 bucket, region, and credentials are required");
    this.client = this.createClient(config.endpoint);
  }
  /** Browser uploads are signed for the public endpoint when one is configured; every server-side call keeps using the internal client. */
  get presignClient(): S3Client { return this.config.publicEndpoint ? (this.publicClient ??= this.createClient(this.config.publicEndpoint)) : this.client; }
  private createClient(endpoint?: string): S3Client { return new S3Client({ endpoint, region: this.config.region, forcePathStyle: this.config.forcePathStyle,
      credentials: { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey } }); }
  async healthcheck(): Promise<void> { await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket })); }
  async createPresignedUploadUrl(input: { key: string; contentType: string; expiresInSeconds: number }) {
    const key = assertObjectKey(input.key); const now = Date.now();
    const url = await getSignedUrl(this.presignClient, new PutObjectCommand({ Bucket: this.config.bucket, Key: key, ContentType: input.contentType }), { expiresIn: input.expiresInSeconds });
    return { url, method: "PUT" as const, headers: { "Content-Type": input.contentType }, expiresAt: new Date(now + input.expiresInSeconds * 1000).toISOString() };
  }
  async headObject(key: string): Promise<ObjectMetadata | null> {
    key = assertObjectKey(key); try { const r = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key })); return { key, contentType: r.ContentType, contentLength: r.ContentLength, etag: r.ETag }; }
    catch (e) { if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null; throw e; }
  }
  async downloadToFile(key: string, destinationPath: string): Promise<void> { const body = await this.getObjectStream(key); await pipeline(body.stream, createWriteStream(destinationPath, { flags: "wx" })); }
  async uploadFile(input: { key: string; sourcePath: string; contentType: string }): Promise<ObjectMetadata> {
    const key = assertObjectKey(input.key); const result = await new Upload({ client: this.client, params: { Bucket: this.config.bucket, Key: key, Body: (await import("node:fs")).createReadStream(input.sourcePath), ContentType: input.contentType } }).done();
    const metadata = await this.headObject(key); return metadata ?? { key, etag: result.ETag };
  }
  async getObjectStream(key: string) { key = assertObjectKey(key); const r = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key })); if (!r.Body) throw new Error("Object body missing"); return { stream: r.Body as NodeJS.ReadableStream, contentType: r.ContentType ?? "application/octet-stream", contentLength: r.ContentLength, etag: r.ETag }; }
  async copyObject(sourceKey: string, destinationKey: string): Promise<void> { sourceKey = assertObjectKey(sourceKey); destinationKey = assertObjectKey(destinationKey); await this.client.send(new CopyObjectCommand({ Bucket: this.config.bucket, CopySource: `${this.config.bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`, Key: destinationKey })); }
  async deleteObject(key: string): Promise<void> { await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: assertObjectKey(key) })); }
  async deletePrefix(prefix: string): Promise<void> { const objects = await this.listPrefix(prefix); for (let i=0;i<objects.length;i+=1000) await this.client.send(new DeleteObjectsCommand({ Bucket: this.config.bucket, Delete: { Objects: objects.slice(i,i+1000).map(({key})=>({Key:key})), Quiet: true } })); }
  async listPrefix(prefix: string): Promise<ObjectMetadata[]> { prefix=assertObjectKey(prefix); const output:ObjectMetadata[]=[]; let token:string|undefined; do { const r=await this.client.send(new ListObjectsV2Command({Bucket:this.config.bucket,Prefix:prefix,ContinuationToken:token})); output.push(...(r.Contents??[]).flatMap(o=>o.Key?[{key:o.Key,contentLength:o.Size,etag:o.ETag}]:[])); token=r.NextContinuationToken; } while(token); return output; }
}
