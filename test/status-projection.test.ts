import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/db/migrate.js";
import { VideoRepository } from "../src/db/video-repository.js";
import { markWorkflowCompleted, markWorkflowFailed, markWorkflowProcessing } from "../src/services/status-projection.js";

describe("workflow status projection", () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  async function seed(id: string): Promise<{ databasePath: string; repository: VideoRepository }> {
    root = await mkdtemp(path.join(os.tmpdir(), "status-projection-"));
    const databasePath = path.join(root, "app.db");
    await migrateDatabase(databasePath);
    const repository = new VideoRepository(databasePath);
    repository.createUploading({ id, originalFilename: "source.mp4", sourcePath: path.join(root, "source.mp4") });
    repository.markUploaded(id);
    repository.markQueued(id, `run-${id}`);
    return { databasePath, repository };
  }

  it("projects workflow start and successful completion", async () => {
    const { databasePath, repository } = await seed("success");
    markWorkflowProcessing(databasePath, "success");
    expect(repository.get("success")?.status).toBe("processing");
    markWorkflowCompleted(databasePath, "success", path.join(root!, "master.m3u8"));
    expect(repository.get("success")).toMatchObject({ status: "completed", processingCompletedAt: expect.any(String) });
    repository.close();
  });

  it("projects only sanitized terminal failure information", async () => {
    const { databasePath, repository } = await seed("failure");
    markWorkflowProcessing(databasePath, "failure");
    markWorkflowFailed(databasePath, "failure", { probe: "Input is /private/user/movie.mp4; requires at least 1280x720" });
    expect(repository.get("failure")).toMatchObject({
      status: "failed", errorCode: "SOURCE_TOO_SMALL", errorMessage: "The source video must be at least 1280x720.",
    });
    expect(repository.get("failure")?.errorMessage).not.toContain("/private/");
    repository.close();
  });
});
