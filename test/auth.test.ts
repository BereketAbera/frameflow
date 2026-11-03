import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import type { AppConfig } from "../src/config.js";
import type { AuthVerifier } from "../src/services/auth.js";
import { FakeObjectStorage } from "../src/storage/fake-storage.js";

describe("Supabase-backed API ownership", () => {
  let root = "";
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  afterEach(async () => { await app?.close(); if (root) await rm(root, { recursive: true, force: true }); });

  it("establishes a session and isolates each user's videos", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "video-auth-"));
    const config: AppConfig = {
      port: 3000, databasePath: path.join(root, "app.db"), uploadDir: path.join(root, "unused"), outputDir: path.join(root, "unused-output"),
      maxUploadBytes: 1_000, reconciliationStaleMinutes: 15, maxConcurrentEncodes: 2, workerTempDir: path.join(root, "scratch"),
      s3: { endpoint: "x", region: "x", bucket: "x", accessKeyId: "x", secretAccessKey: "x", forcePathStyle: true, presignedUploadTtlSeconds: 600 },
      workerCallbackSecret: "secret", supabase: { url: "https://example.supabase.co", anonKey: "public-anon-key" },
    };
    const verifier: AuthVerifier = { verify: async (token) => token.startsWith("user-") ? { id: token, email: `${token}@example.com` } : null };
    app = await buildApp({ config, storage: new FakeObjectStorage(), authVerifier: verifier, submitter: { submit: async () => ({ runId: "run" }) } });

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
  });
});
