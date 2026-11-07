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
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
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
});
