import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { buildApp } from "../src/api/app.js";
import { VideoRepository } from "../src/db/video-repository.js";
import type { WorkflowSubmitter } from "../src/services/workflow-submitter.js";
import type { VideoProcessingInput } from "../src/workflows/video-processing.js";

class FakeSubmitter implements WorkflowSubmitter {
  inputs: VideoProcessingInput[] = [];
  async submit(input: VideoProcessingInput): Promise<{ runId: string }> {
    this.inputs.push(input);
    return { runId: `run-${input.videoId}` };
  }
}

function multipart(filename: string, mime: string, data: Buffer): { payload: Buffer; contentType: string } {
  const boundary = "----video-poc-test-boundary";
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([prefix, data, suffix]), contentType: `multipart/form-data; boundary=${boundary}` };
}

function fakeMp4(extraBytes = 16): Buffer {
  const buffer = Buffer.alloc(12 + extraBytes);
  buffer.writeUInt32BE(buffer.length, 0);
  buffer.write("ftyp", 4, "ascii");
  buffer.write("isom", 8, "ascii");
  return buffer;
}

describe("video API", () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function setup(maxUploadBytes = 1024 * 1024) {
    const root = await mkdtemp(path.join(os.tmpdir(), "video-api-"));
    directories.push(root);
    const config: AppConfig = {
      port: 3000, databasePath: path.join(root, "app.db"), uploadDir: path.join(root, "uploads"),
      outputDir: path.join(root, "output"), maxUploadBytes, reconciliationStaleMinutes: 15,
      maxConcurrentEncodes: 2,
      workerTempDir: path.join(root, "worker"),
      s3: { endpoint: "http://storage.test", region: "us-east-1", bucket: "test", accessKeyId: "test", secretAccessKey: "test", forcePathStyle: true, presignedUploadTtlSeconds: 600 },
    };
    const submitter = new FakeSubmitter();
    const app = await buildApp({ config, submitter });
    apps.push(app);
    return { app, config, submitter };
  }

  it("streams a valid upload, queues Hatchet, and returns 202", async () => {
    const { app, submitter } = await setup();
    const body = multipart("client-name.mp4", "video/mp4", fakeMp4());
    const response = await app.inject({ method: "POST", url: "/videos", headers: { "content-type": body.contentType }, payload: body.payload });
    expect(response.statusCode).toBe(202);
    const json = response.json();
    expect(json).toMatchObject({ status: "queued", statusUrl: `/videos/${json.id}`, playerUrl: `/player/${json.id}` });
    expect(submitter.inputs).toHaveLength(1);
    expect(submitter.inputs[0]).toMatchObject({ videoId: json.id, databasePath: expect.any(String) });
    expect(path.basename(submitter.inputs[0]!.sourcePath)).toBe("source.mp4");
    const repository = new VideoRepository(submitter.inputs[0]!.databasePath!);
    expect(repository.get(json.id)).toMatchObject({ status: "queued", hatchetRunId: `run-${json.id}`, originalFilename: "client-name.mp4" });
    repository.close();
  });

  it("rejects unsupported uploads and oversized uploads safely", async () => {
    const first = await setup();
    const text = multipart("not-video.txt", "text/plain", Buffer.from("hello"));
    const unsupported = await first.app.inject({ method: "POST", url: "/videos", headers: { "content-type": text.contentType }, payload: text.payload });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toEqual({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Only MP4 uploads are supported." } });

    const second = await setup(24);
    const large = multipart("large.mp4", "video/mp4", fakeMp4(100));
    const oversized = await second.app.inject({ method: "POST", url: "/videos", headers: { "content-type": large.contentType }, payload: large.payload });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error.code).toBe("UPLOAD_TOO_LARGE");
  });

  it("returns unknown and each product-facing state without local paths", async () => {
    const { app, config } = await setup();
    expect((await app.inject({ method: "GET", url: "/videos/missing" })).statusCode).toBe(404);
    const repository = new VideoRepository(config.databasePath);
    repository.createUploading({ id: "states", originalFilename: "a.mp4", sourcePath: "/private/source.mp4" });
    repository.markUploaded("states");
    repository.markQueued("states", "run-states");
    expect((await app.inject({ method: "GET", url: "/videos/states" })).json()).toMatchObject({ status: "queued" });
    repository.markProcessing("states");
    expect((await app.inject({ method: "GET", url: "/videos/states" })).json()).toMatchObject({ status: "processing" });
    repository.markCompleted("states", "/private/master.m3u8");
    const complete = (await app.inject({ method: "GET", url: "/videos/states" })).json();
    expect(complete).toMatchObject({ status: "completed", playbackUrl: "/streams/states/master.m3u8" });
    expect(JSON.stringify(complete)).not.toContain("/private/");

    repository.createUploading({ id: "failed", originalFilename: "b.mp4", sourcePath: "/private/b.mp4" });
    repository.markFailed("failed", "INVALID_VIDEO", "The upload is not a supported video.");
    expect((await app.inject({ method: "GET", url: "/videos/failed" })).json()).toMatchObject({
      status: "failed", error: { code: "INVALID_VIDEO", message: "The upload is not a supported video." },
    });
    repository.close();
  });

  it("serves only allowlisted HLS files and only after completion", async () => {
    const { app, config } = await setup();
    const repository = new VideoRepository(config.databasePath);
    repository.createUploading({ id: "streamable", originalFilename: "a.mp4", sourcePath: "/source.mp4" });
    repository.markUploaded("streamable");
    repository.markProcessing("streamable");
    const output = path.join(config.outputDir, "streamable");
    await mkdir(path.join(output, "360p"), { recursive: true });
    await writeFile(path.join(output, "master.m3u8"), "#EXTM3U\n");
    await writeFile(path.join(output, "secret.txt"), "secret");
    expect((await app.inject({ method: "GET", url: "/streams/streamable/master.m3u8" })).statusCode).toBe(404);
    repository.markCompleted("streamable", path.join(output, "master.m3u8"));
    const playlist = await app.inject({ method: "GET", url: "/streams/streamable/master.m3u8" });
    expect(playlist.statusCode).toBe(200);
    expect(playlist.headers["content-type"]).toContain("application/vnd.apple.mpegurl");
    expect((await app.inject({ method: "GET", url: "/streams/streamable/secret.txt" })).statusCode).toBe(400);
    const traversal = await app.inject({ method: "GET", url: "/streams/streamable/%2e%2e%2fapp.db" });
    expect([400, 404]).toContain(traversal.statusCode);
    repository.close();
  });
});
