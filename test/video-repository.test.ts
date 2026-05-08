import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/db/migrate.js";
import { VideoRepository } from "../src/db/video-repository.js";

describe("VideoRepository", () => {
  let directory: string | undefined;
  let repository: VideoRepository | undefined;

  afterEach(async () => {
    repository?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function setup(): Promise<VideoRepository> {
    directory = await mkdtemp(path.join(os.tmpdir(), "video-repository-"));
    const databasePath = path.join(directory, "app.db");
    await migrateDatabase(databasePath);
    repository = new VideoRepository(databasePath);
    return repository;
  }

  it("persists the expected lifecycle", async () => {
    const repo = await setup();
    repo.createUploading({ id: "video-1", originalFilename: "original.mp4", sourcePath: "/safe/source.mp4" });
    expect(repo.markUploaded("video-1").status).toBe("uploaded");
    expect(repo.markQueued("video-1", "run-1")).toMatchObject({ status: "queued", hatchetRunId: "run-1" });
    expect(repo.markProcessing("video-1")).toMatchObject({ status: "processing" });
    expect(repo.markCompleted("video-1", "/safe/master.m3u8")).toMatchObject({
      status: "completed", masterPlaylistPath: "/safe/master.m3u8", errorCode: null,
    });
  });

  it("does not regress or replace terminal states", async () => {
    const repo = await setup();
    repo.createUploading({ id: "complete", originalFilename: "a.mp4", sourcePath: "/a.mp4" });
    repo.markUploaded("complete");
    repo.markCompleted("complete", "/master.m3u8");
    expect(repo.markProcessing("complete").status).toBe("completed");
    expect(repo.markFailed("complete", "LATE_ERROR", "late").status).toBe("completed");
    expect(repo.markQueued("complete", "late-run")).toMatchObject({ status: "completed", hatchetRunId: "late-run" });

    repo.createUploading({ id: "failed", originalFilename: "b.mp4", sourcePath: "/b.mp4" });
    repo.markFailed("failed", "UPLOAD_FAILED", "failed safely");
    expect(repo.markProcessing("failed")).toMatchObject({ status: "failed", errorMessage: "failed safely" });
  });
});
