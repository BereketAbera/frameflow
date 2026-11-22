import { createHash } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PUBLIC_PREFIX } from "../shared/contract.js";

export type StoredObjectInfo = { key: string; size: number; etag: string; contentType?: string; cacheControl?: string };
export type StoredObject = StoredObjectInfo & { body: Uint8Array };
export type PutInput = { key: string; body: Uint8Array; contentType: string; cacheControl: string };

/**
 * The publisher's whole view of the bucket. Both writes are conditional, there is no unconditional one, and there is
 * no delete: a versioned object is only ever created, and the active reference is only ever replaced by whoever read
 * its current state. Nothing the publisher does can make an object disappear or change under a reader.
 */
export interface ReleaseStore {
  /** Creates the object if the key is free. An existing object is left untouched and reported as created: false. */
  createOnly(input: PutInput): Promise<{ created: true; etag: string } | { created: false }>;
  /** Replaces the object only while its ETag is still ifMatch. */
  replaceIfMatch(input: PutInput & { ifMatch: string }): Promise<{ replaced: true; etag: string } | { replaced: false }>;
  head(key: string): Promise<StoredObjectInfo | null>;
  get(key: string): Promise<StoredObject | null>;
  list(prefix: string): Promise<StoredObjectInfo[]>;
}

export type S3StoreConfig = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string; forcePathStyle: boolean };

/** The publisher has no business outside the public prefix, so the store refuses every other key before any request is sent. */
export function assertPublicKey(key: string): string {
  if (!key.startsWith(`${PUBLIC_PREFIX}/`) || key.includes("..") || key.includes("//") || key.includes("\\") || /[\0\r\n]/.test(key)) throw new Error(`Refusing to touch an object outside ${PUBLIC_PREFIX}/: ${JSON.stringify(key)}`);
  return key;
}

/**
 * Reads the publisher's own PUBLIC_DEMO_S3_* settings. They are separate from the application's S3_* settings on
 * purpose: the publisher never reads the private bucket's configuration, and it only accepts a bucket whose name
 * says it is the public demo bucket.
 */
export function loadStoreConfig(env: NodeJS.ProcessEnv = process.env): S3StoreConfig {
  const read = (name: string) => (env[name] ?? "").trim();
  const endpoint = read("PUBLIC_DEMO_S3_ENDPOINT"), bucket = read("PUBLIC_DEMO_S3_BUCKET"), accessKeyId = read("PUBLIC_DEMO_S3_ACCESS_KEY_ID"), secretAccessKey = read("PUBLIC_DEMO_S3_SECRET_ACCESS_KEY");
  const missing = Object.entries({ PUBLIC_DEMO_S3_ENDPOINT: endpoint, PUBLIC_DEMO_S3_BUCKET: bucket, PUBLIC_DEMO_S3_ACCESS_KEY_ID: accessKeyId, PUBLIC_DEMO_S3_SECRET_ACCESS_KEY: secretAccessKey }).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) throw new Error(`Missing ${missing.join(", ")}. See edge/.env.example.`);
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("PUBLIC_DEMO_S3_ENDPOINT must be a URL such as https://<account-id>.r2.cloudflarestorage.com"); }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("PUBLIC_DEMO_S3_ENDPOINT must use https, except for a local endpoint");
  if (url.search || url.hash || url.username || url.password) throw new Error("PUBLIC_DEMO_S3_ENDPOINT must not carry a query, fragment or credentials");
  // With path-style addressing a path on the endpoint would itself be read as the bucket, past the name check below.
  if (!local && url.pathname !== "/") throw new Error("PUBLIC_DEMO_S3_ENDPOINT must be an origin without a path");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !bucket.includes("public-demo")) throw new Error("PUBLIC_DEMO_S3_BUCKET must be the dedicated public demo bucket: a name that contains \"public-demo\"");
  const forcePathStyle = read("PUBLIC_DEMO_S3_FORCE_PATH_STYLE").toLowerCase();
  if (forcePathStyle && !["true", "false"].includes(forcePathStyle)) throw new Error("PUBLIC_DEMO_S3_FORCE_PATH_STYLE must be true or false");
  return { endpoint: url.href.replace(/\/$/, ""), bucket, accessKeyId, secretAccessKey, region: read("PUBLIC_DEMO_S3_REGION") || "auto", forcePathStyle: forcePathStyle !== "false" };
}

/**
 * Every conditional write hangs on an ETag. A missing one must stop the operation: the SDK leaves an empty If-Match
 * out of the request, which would turn a compare-and-swap into a plain overwrite.
 */
function requireEtag(etag: string | undefined, key: string): string {
  if (!etag || !/^"[^"]+"$/.test(etag)) throw new Error(`The bucket returned no usable ETag for ${key}`);
  return etag;
}

type S3Failure = { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
const statusOf = (error: unknown): number | undefined => (error as S3Failure).$metadata?.httpStatusCode;
const codeOf = (error: unknown): string | undefined => (error as S3Failure).Code ?? (error as S3Failure).name;
const isMissing = (error: unknown): boolean => statusOf(error) === 404 || codeOf(error) === "NoSuchKey" || codeOf(error) === "NotFound";
/** 412 is a failed precondition. 409 is the store reporting a competing conditional write on the same key. */
const lostCondition = (error: unknown): boolean => statusOf(error) === 412 || statusOf(error) === 409 || codeOf(error) === "PreconditionFailed" || codeOf(error) === "ConditionalRequestConflict";

export class S3ReleaseStore implements ReleaseStore {
  readonly client: S3Client;
  constructor(private readonly config: S3StoreConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // R2 takes the plain signed request. The SDK's optional checksum trailers are neither needed nor sent.
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  /** Content-MD5 makes the store reject a body damaged in transit, and the ETag it answers with must be that MD5. */
  private async put(input: PutInput, condition: { IfNoneMatch: string } | { IfMatch: string }): Promise<string> {
    const md5 = createHash("md5").update(input.body).digest();
    const result = await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket, Key: assertPublicKey(input.key), Body: input.body, ContentLength: input.body.length,
      ContentType: input.contentType, CacheControl: input.cacheControl, ContentMD5: md5.toString("base64"), ...condition,
    }));
    const expected = `"${md5.toString("hex")}"`;
    if (result.ETag !== expected) throw new Error(`The bucket stored ${input.key} with ETag ${result.ETag ?? "none"}, not the expected ${expected}`);
    return expected;
  }

  async createOnly(input: PutInput): Promise<{ created: true; etag: string } | { created: false }> {
    try { return { created: true, etag: await this.put(input, { IfNoneMatch: "*" }) }; }
    catch (error) { if (lostCondition(error)) return { created: false }; throw error; }
  }

  async replaceIfMatch(input: PutInput & { ifMatch: string }): Promise<{ replaced: true; etag: string } | { replaced: false }> {
    const ifMatch = requireEtag(input.ifMatch, input.key);
    try { return { replaced: true, etag: await this.put(input, { IfMatch: ifMatch }) }; }
    catch (error) { if (lostCondition(error) || isMissing(error)) return { replaced: false }; throw error; }
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: assertPublicKey(key) }));
      return { key, size: result.ContentLength ?? 0, etag: requireEtag(result.ETag, key), contentType: result.ContentType, cacheControl: result.CacheControl };
    } catch (error) { if (isMissing(error)) return null; throw error; }
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: assertPublicKey(key) }));
      if (!result.Body) throw new Error(`The bucket returned no body for ${key}`);
      const body = await result.Body.transformToByteArray();
      return { key, body, size: body.length, etag: requireEtag(result.ETag, key), contentType: result.ContentType, cacheControl: result.CacheControl };
    } catch (error) { if (isMissing(error)) return null; throw error; }
  }

  async list(prefix: string): Promise<StoredObjectInfo[]> {
    const objects: StoredObjectInfo[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: assertPublicKey(prefix), ContinuationToken: token }));
      for (const object of page.Contents ?? []) if (object.Key) objects.push({ key: object.Key, size: object.Size ?? 0, etag: requireEtag(object.ETag, object.Key) });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return objects;
  }

  destroy(): void { this.client.destroy(); }
}
