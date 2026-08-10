import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import type { AppConfig } from "../src/config.js";
import type { AuthVerifier } from "../src/services/auth.js";
import { FakeObjectStorage } from "../src/storage/fake-storage.js";
import { VideoRepository } from "../src/db/video-repository.js";

describe("Supabase-backed API ownership", () => {
  let root = "";
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  afterEach(async () => { await app?.close(); if (root) await rm(root, { recursive: true, force: true }); });

  it("establishes a session and isolates each user's videos", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "video-auth-"));
    const config: AppConfig = {
      port: 3000, host: "127.0.0.1", databasePath: path.join(root, "app.db"), uploadDir: path.join(root, "unused"), outputDir: path.join(root, "unused-output"),
      maxUploadBytes: 1_000, reconciliationStaleMinutes: 15, maxConcurrentEncodes: 2, workerTempDir: path.join(root, "scratch"),
      s3: { endpoint: "x", region: "x", bucket: "x", accessKeyId: "x", secretAccessKey: "x", forcePathStyle: true, presignedUploadTtlSeconds: 600 },
      workerCallbackSecret: "secret", supabase: { url: "https://example.supabase.co", anonKey: "public-anon-key" },
    };
    const verifier: AuthVerifier = { verify: async (token) => token.startsWith("user-") ? { id: token, email: `${token}@example.com` } : null };
    const storage = new FakeObjectStorage();
    app = await buildApp({ config, storage, authVerifier: verifier, submitter: { submit: async () => ({ runId: "run" }) } });

    expect((await app.inject({ method: "GET", url: "/videos" })).statusCode).toBe(401);
    const session = await app.inject({ method: "POST", url: "/auth/session", headers: { authorization: "Bearer user-a" } });
    expect(session.statusCode).toBe(200);
    expect(session.headers["set-cookie"]).toContain("HttpOnly");

    const created = await app.inject({ method: "POST", url: "/videos/uploads", headers: { authorization: "Bearer user-a" }, payload: { filename: "mine.mp4", contentType: "video/mp4", sizeBytes: 20 } });
    expect(created.statusCode).toBe(201);
    const id = created.json().videoId;
    const mine = await app.inject({ method: "GET", url: "/videos", headers: { authorization: "Bearer user-a" } });
    const theirs = await app.inject({ method: "GET", url: "/videos", headers: { authorization: "Bearer user-b" } });
    expect(mine.json().videos).toHaveLength(1);
    expect(mine.json().videos[0].originalFilename).toBe("mine.mp4");
    expect(theirs.json().videos).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: `/videos/${id}`, headers: { authorization: "Bearer user-b" } })).statusCode).toBe(404);
    storage.put(`videos/${id}/source/source.mp4`,Buffer.alloc(20),"video/mp4");
    await app.inject({method:"POST",url:`/videos/${id}/upload-complete`,headers:{authorization:"Bearer user-a"}});
    await app.inject({method:"POST",url:`/internal/videos/${id}/completed`,headers:{"x-worker-secret":"secret"},payload:{masterPlaylistObjectKey:`videos/${id}/published/master.m3u8`}});
    storage.put(`videos/${id}/published/master.m3u8`,Buffer.from("#EXTM3U\n"),"application/vnd.apple.mpegurl");
    await app.inject({method:"PATCH",url:`/social/videos/${id}`,headers:{authorization:"Bearer user-a"},payload:{title:"Public film",description:"Visible to everyone",tags:"ai",visibility:"public"}});
    expect((await app.inject({method:"GET",url:`/social/videos/${id}`})).statusCode).toBe(200);
    const publicStream=await app.inject({method:"GET",url:`/streams/${id}/master.m3u8`});
    expect(publicStream.statusCode).toBe(200);expect(publicStream.headers["cache-control"]).toContain("public");
    await app.inject({method:"PATCH",url:`/social/videos/${id}`,headers:{authorization:"Bearer user-a"},payload:{title:"Private film",description:"Owner only",tags:"ai",visibility:"private"}});
    expect((await app.inject({method:"GET",url:`/social/videos/${id}`})).statusCode).toBe(404);
    expect((await app.inject({method:"POST",url:`/social/videos/${id}/like`,headers:{authorization:"Bearer user-b"}})).statusCode).toBe(404);
    await app.inject({method:"PATCH",url:`/social/videos/${id}`,headers:{authorization:"Bearer user-a"},payload:{title:"Public film",description:"Visible to everyone",tags:"ai",visibility:"public"}});
    expect((await app.inject({method:"POST",url:`/social/videos/${id}/like`,headers:{authorization:"Bearer user-b"}})).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:`/social/videos/${id}/comments`,headers:{authorization:"Bearer user-b"},payload:{body:"Great film"}})).statusCode).toBe(201);
    expect((await app.inject({method:"GET",url:"/social/notifications",headers:{authorization:"Bearer user-a"}})).json().notifications).toHaveLength(2);
    expect((await app.inject({ method: "DELETE", url: `/videos/${id}`, headers: { authorization: "Bearer user-b" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/videos/${id}`, headers: { authorization: "Bearer user-a" } })).statusCode).toBe(204);
    const repository = new VideoRepository(config.databasePath);
    expect(repository.database.prepare("SELECT count(*) count FROM video_likes WHERE video_id=?").get(id)).toEqual({count:0});
    expect(repository.database.prepare("SELECT count(*) count FROM comments WHERE video_id=?").get(id)).toEqual({count:0});
    repository.close();
  });
});
