import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/db/migrate.js";
import { VideoRepository } from "../src/db/video-repository.js";
import { reconcileVideos, type RunInspector, type InspectedRun } from "../src/services/reconciliation.js";
import { FakeObjectStorage } from "../src/storage/fake-storage.js";

class FakeInspector implements RunInspector {
  constructor(private readonly runs: Record<string, InspectedRun>) {}
  async inspect(runId: string): Promise<InspectedRun> { return this.runs[runId] ?? { status: "queued" }; }
}

describe("reconciliation", () => {
  let root: string | undefined;
  let repository: VideoRepository | undefined;
  afterEach(async () => { repository?.close(); if (root) await rm(root, { recursive: true, force: true }); });

  it("repairs completed and failed drift and is idempotent", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "video-reconcile-"));
    const databasePath = path.join(root, "app.db");
    const outputDir = path.join(root, "output");
    await migrateDatabase(databasePath);
    repository = new VideoRepository(databasePath, () => "2026-01-01T00:00:00.000Z");
    for (const id of ["done", "broken"]) {
      repository.createUploading({ id, originalFilename: `${id}.mp4`, sourcePath: path.join(root, `${id}.mp4`) });
      repository.markUploaded(id);
      repository.markQueued(id, `run-${id}`);
      repository.markProcessing(id);
    }
    const master = path.join(outputDir, "done", "master.m3u8");
    await mkdir(path.dirname(master), { recursive: true });
    await writeFile(master, "#EXTM3U\n");
    const inspector = new FakeInspector({
      "run-done": { status: "completed", finalOutput: { masterPlaylistPath: master } },
      "run-broken": { status: "failed", errors: { probe: "invalid video stream" } },
    });
    const options = { repository, inspector, outputDir, staleBefore: "2026-01-02T00:00:00.000Z" };
    expect(await reconcileVideos(options)).toEqual({ inspected: 2, repaired: 2 });
    expect(repository.get("done")).toMatchObject({ status: "completed", masterPlaylistPath: master });
    expect(repository.get("broken")).toMatchObject({ status: "failed", errorCode: "INVALID_VIDEO" });
    expect(await reconcileVideos(options)).toEqual({ inspected: 0, repaired: 0 });
  });

  it("repairs an object-backed completion only when the published master exists", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "video-reconcile-object-"));
    const databasePath = path.join(root, "app.db");
    await migrateDatabase(databasePath);
    repository = new VideoRepository(databasePath, () => "2026-01-01T00:00:00.000Z");
    const storage = new FakeObjectStorage();
    repository.createPendingUpload({ id: "object-done", originalFilename: "clip.mp4", sourceObjectKey: "videos/object-done/source/source.mp4", outputPrefix: "videos/object-done/published", sizeBytes: 10, expiresAt: "2026-01-01T01:00:00.000Z" });
    repository.markObjectUploaded("object-done", { sizeBytes: 10 });
    repository.markQueued("object-done", "run-object-done");
    repository.markProcessing("object-done");
    storage.put("videos/object-done/published/master.m3u8", Buffer.from("#EXTM3U\n"), "application/vnd.apple.mpegurl");
    const inspector = new FakeInspector({ "run-object-done": { status: "completed" } });
    const options = { repository, inspector, storage, outputDir: path.join(root, "output"), staleBefore: "2026-01-02T00:00:00.000Z" };
    expect(await reconcileVideos(options)).toEqual({ inspected: 1, repaired: 1 });
    expect(repository.get("object-done")).toMatchObject({ status: "completed", masterPlaylistObjectKey: "videos/object-done/published/master.m3u8", masterPlaylistPath: null });
    expect(await reconcileVideos(options)).toEqual({ inspected: 0, repaired: 0 });
  });
});
