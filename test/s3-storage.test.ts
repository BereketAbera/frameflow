import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { S3ObjectStorage, type S3StorageConfig } from "../src/storage/s3-storage.js";

const base: S3StorageConfig = { region: "us-east-1", bucket: "frameflow", accessKeyId: "test-access-key", secretAccessKey: "test-secret-key", forcePathStyle: true };
const key = "videos/abc/source/source.mp4";

describe("S3 presigned uploads", () => {
  const storages: S3ObjectStorage[] = [];
  afterEach(() => { for (const storage of storages.splice(0)) { storage.client.destroy(); storage.presignClient.destroy(); } });
  const create = (config: Partial<S3StorageConfig>) => { const storage = new S3ObjectStorage({ ...base, ...config }); storages.push(storage); return storage; };

  it("signs browser uploads for the public endpoint while server calls stay internal", async () => {
    const storage = create({ endpoint: "http://frameflow-minio:9000", publicEndpoint: "https://frameflow.bereket.dev" });
    const upload = await storage.createPresignedUploadUrl({ key, contentType: "video/mp4", expiresInSeconds: 600 });
    const url = new URL(upload.url);
    expect(url.origin).toBe("https://frameflow.bereket.dev");
    expect(url.pathname).toBe(`/frameflow/${key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    // The signature covers the Content-Type the browser must send, so storage rejects a PUT of any other type.
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect(upload).toMatchObject({ method: "PUT", headers: { "Content-Type": "video/mp4" } });
    expect(storage.presignClient).not.toBe(storage.client);
    expect(await storage.client.config.endpoint?.()).toMatchObject({ protocol: "http:", hostname: "frameflow-minio", port: 9000 });
  });

  it("keeps signing against the storage endpoint when no public endpoint is configured", async () => {
    const storage = create({ endpoint: "http://127.0.0.1:9000" });
    const url = new URL((await storage.createPresignedUploadUrl({ key, contentType: "video/mp4", expiresInSeconds: 60 })).url);
    expect(url.origin).toBe("http://127.0.0.1:9000");
    expect(url.pathname).toBe(`/frameflow/${key}`);
    expect(storage.presignClient).toBe(storage.client);
  });

  it("signs AWS uploads virtual-hosted when S3_ENDPOINT is the regional endpoint", async () => {
    const storage = create({ endpoint: "https://s3.eu-west-1.amazonaws.com", region: "eu-west-1", forcePathStyle: false });
    const url = new URL((await storage.createPresignedUploadUrl({ key, contentType: "video/mp4", expiresInSeconds: 60 })).url);
    expect(url.origin).toBe("https://frameflow.s3.eu-west-1.amazonaws.com");
    expect(url.pathname).toBe(`/${key}`);
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/\/eu-west-1\/s3\/aws4_request$/);
  });
});

describe("S3 transfers honour cancellation", () => {
  let root = "", server: Server | undefined, storage: S3ObjectStorage | undefined;
  afterEach(async () => {
    storage?.client.destroy(); storage = undefined;
    server?.closeAllConnections(); await new Promise((resolve) => server ? server.close(resolve) : resolve(undefined)); server = undefined;
    if (root) await rm(root, { recursive: true, force: true });
  });
  // A storage endpoint that accepts every request and then stalls: GET bodies stop after the first chunk, PUTs never get a response.
  async function stallingStorage() {
    root = await mkdtemp(path.join(os.tmpdir(), "s3-abort-"));
    const requests: string[] = [];
    server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "GET") { response.writeHead(200, { "content-type": "video/mp4", "content-length": String(8 * 1024 * 1024) }); response.write(Buffer.alloc(64 * 1024)); }
      else request.resume();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    storage = new S3ObjectStorage({ ...base, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    return { storage, requests };
  }
  const waitFor = async (condition: () => boolean) => { for (const deadline = Date.now() + 5_000; !condition(); await new Promise((resolve) => setTimeout(resolve, 10))) if (Date.now() > deadline) throw new Error("Timed out"); };

  it("aborts a download that is streaming", async () => {
    const { storage, requests } = await stallingStorage(), controller = new AbortController(), destination = path.join(root, "source.mp4");
    const download = storage.downloadToFile(key, destination, controller.signal);
    await waitFor(() => requests.length === 1 && existsSync(destination));
    const abortedAt = Date.now();
    controller.abort();
    await expect(download).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
  });

  it("aborts an upload that is waiting on storage", async () => {
    const { storage, requests } = await stallingStorage(), controller = new AbortController(), source = path.join(root, "segment-000.ts");
    await writeFile(source, Buffer.alloc(1024));
    const upload = storage.uploadFile({ key: "videos/abc/staging/run/360p/segment-000.ts", sourcePath: source, contentType: "video/mp2t", signal: controller.signal });
    await waitFor(() => requests.length === 1);
    controller.abort();
    await expect(upload).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
  });

  it("does not start transfers for an aborted signal", async () => {
    const { storage, requests } = await stallingStorage(), destination = path.join(root, "never.mp4");
    await expect(storage.downloadToFile(key, destination, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    await expect(storage.uploadFile({ key, sourcePath: path.join(root, "missing.mp4"), contentType: "video/mp4", signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toEqual([]);
    expect(existsSync(destination)).toBe(false);
  });
});
