import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { S3ReleaseStore, type S3StoreConfig } from "../src/publisher/store.js";
import { workerBundle } from "./build-worker.js";

export const LOCAL_BUCKET = "frameflow-public-demo-local";
const credentials = { accessKeyId: "local-access-key", secretAccessKey: "local-secret-key" };

/** The R2 binding as the Worker has it. Tests use it to plant objects the publisher would refuse to write. */
type Bucket = Awaited<ReturnType<Miniflare["getR2Bucket"]>>;

export type LocalEdge = {
  /** Origin of the Worker, such as http://127.0.0.1:51234. */
  origin: string;
  storeConfig: S3StoreConfig;
  /** The publisher's store, talking S3 to the same bucket the Worker reads through its binding. */
  store: S3ReleaseStore;
  bucket: Bucket;
  /** A request to the Worker. Redirects are returned, not followed. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
};

/**
 * Runs the built Worker in workerd with a local R2 bucket, and exposes that bucket twice: through the Worker's
 * binding and through the local S3 endpoint, which honours conditional writes. That is the production shape: the
 * publisher writes over the S3 API, the Worker reads through its binding.
 */
export async function startLocalEdge(options: { port?: number; environment?: string } = {}): Promise<LocalEdge> {
  const miniflare = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: workerBundle,
    compatibilityDate: "2026-11-01",
    host: "127.0.0.1",
    port: options.port ?? 0,
    // No request here passes through Cloudflare, so the location the Worker reports must not look like a real one.
    cf: { colo: "LOCAL" },
    r2Buckets: { PUBLIC_DEMO: { id: LOCAL_BUCKET, s3Credentials: credentials } },
    bindings: { ENVIRONMENT: options.environment ?? "local", CACHE_EPOCH: "1" },
  }));
  const origin = (await miniflare.ready).origin;
  const storeConfig: S3StoreConfig = { endpoint: `${origin}/cdn-cgi/local/r2/s3`, bucket: LOCAL_BUCKET, region: "auto", forcePathStyle: true, ...credentials };
  const store = new S3ReleaseStore(storeConfig);
  return {
    origin, storeConfig, store,
    bucket: await miniflare.getR2Bucket("PUBLIC_DEMO"),
    fetch: (path, init) => fetch(`${origin}${path}`, { redirect: "manual", ...init }),
    async dispose() { store.destroy(); await miniflare.dispose(); },
  };
}

/** The edge cache is filled after the response has been sent, so a repeat request may need a moment before it hits. */
export async function untilCached(edge: LocalEdge, path: string, init?: RequestInit): Promise<Response> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const response = await edge.fetch(path, init);
    if (response.headers.get("x-frameflow-cache") === "HIT" || Date.now() > deadline) return response;
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
