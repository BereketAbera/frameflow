import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/api/app.js";
import type { AppConfig, OwnerAuthConfig } from "../src/config.js";
import { OwnerAccess } from "../src/services/auth.js";
import { VideoRepository } from "../src/db/video-repository.js";
import { FakeObjectStorage } from "../src/storage/fake-storage.js";

const accessKey = "test-owner-access-key-not-a-real-secret";
const sessionSecret = "test-session-secret-0123456789-abcdefghij";
const owner: OwnerAuthConfig = { tokenSha256: createHash("sha256").update(accessKey).digest("hex"), sessionSecret, userId: "local-development", sessionMaxAgeSeconds: 43_200 };
const ownerHeaders = { authorization: `Bearer ${accessKey}` };
const nowSeconds = () => Math.floor(Date.now() / 1000);
const forgedSession = (expiry: number, secret = sessionSecret) => `owner.${expiry}.${createHmac("sha256", secret).update(`owner.${expiry}`).digest("base64url")}`;
const cookie = (session: string) => ({ cookie: `vp_session=${session}` });
const baseConfig = (root: string, database = "app.db"): AppConfig => ({
  port: 3000, host: "127.0.0.1", databasePath: path.join(root, database), uploadDir: path.join(root, "unused"), outputDir: path.join(root, "unused-output"),
  maxUploadBytes: 1_000, reconciliationStaleMinutes: 15, maxConcurrentEncodes: 2, workerTempDir: path.join(root, "scratch"),
  s3: { endpoint: "x", region: "x", bucket: "x", accessKeyId: "x", secretAccessKey: "x", forcePathStyle: true, presignedUploadTtlSeconds: 600 },
  workerCallbackSecret: "secret",
});

describe("owner-only access mode", () => {
  let root = "";
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  afterEach(async () => { vi.unstubAllEnvs(); await app?.close(); app = undefined; if (root) await rm(root, { recursive: true, force: true }); });

  async function setup() {
    root = await mkdtemp(path.join(os.tmpdir(), "owner-auth-"));
    const config: AppConfig = { ...baseConfig(root), owner };
    const storage = new FakeObjectStorage();
    app = await buildApp({ config, storage, submitter: { submit: async () => ({ runId: "run" }) } });
    const repository = new VideoRepository(config.databasePath);
    for (const id of ["public-film", "private-film"]) {
      repository.createPendingUpload({ id, userId: owner.userId, originalFilename: `${id}.mp4`, sourceObjectKey: `videos/${id}/source/source.mp4`, outputPrefix: `videos/${id}/published`, sizeBytes: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      repository.markObjectUploaded(id, { sizeBytes: 1 });
      repository.markQueued(id, `run-${id}`);
      repository.markObjectCompleted(id, `videos/${id}/published/master.m3u8`);
      storage.put(`videos/${id}/published/master.m3u8`, Buffer.from("#EXTM3U\n"), "application/vnd.apple.mpegurl");
    }
    repository.close();
    const publish = await app.inject({ method: "PATCH", url: "/social/videos/public-film", headers: ownerHeaders, payload: { title: "Public film", description: "", tags: "", visibility: "public" } });
    expect(publish.statusCode).toBe(200);
    return { app, storage };
  }

  it("advertises owner mode without exposing secrets", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/auth/config" })).json()).toEqual({ enabled: true, mode: "owner" });
  });

  it("exchanges the access key for a signed, HttpOnly session cookie", async () => {
    const { app } = await setup();
    vi.stubEnv("NODE_ENV", "production");
    const session = await app.inject({ method: "POST", url: "/auth/session", headers: ownerHeaders });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ user: { id: "local-development" } });
    const setCookie = String(session.headers["set-cookie"]);
    expect(setCookie).toMatch(/^vp_session=owner\.\d+\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
    expect(setCookie).not.toContain(accessKey);
    const value = /^vp_session=([^;]+)/.exec(setCookie)![1]!;
    const expiry = Number(value.split(".")[1]);
    expect(expiry).toBeGreaterThan(nowSeconds() + 43_200 - 5);
    expect(expiry).toBeLessThanOrEqual(nowSeconds() + 43_200);
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: cookie(value) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ id: "local-development" });
  });

  it("signs out by expiring the session cookie with the same attributes", async () => {
    const { app } = await setup();
    vi.stubEnv("NODE_ENV", "production");
    const signedOut = await app.inject({ method: "DELETE", url: "/auth/session" });
    expect(signedOut.statusCode).toBe(200);
    expect(signedOut.headers["set-cookie"]).toBe("vp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
  });

  it("rejects a wrong or missing access key", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "POST", url: "/auth/session", headers: { authorization: "Bearer not-the-key" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/session" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: "Bearer not-the-key" } })).statusCode).toBe(401);
    const sessionCookie = cookie(forgedSession(nowSeconds() + 60)).cookie;
    expect((await app.inject({ method: "POST", url: "/auth/session", headers: { cookie: sessionCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/videos", headers: { authorization: "Bearer not-the-key", cookie: sessionCookie } })).statusCode).toBe(401);
  });

  it("rejects tampered, expired, and over-long sessions", async () => {
    const { app } = await setup();
    const valid = forgedSession(nowSeconds() + 600);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: cookie(valid) })).statusCode).toBe(200);
    const [, expiry, signature] = valid.split(".");
    const flipped = `${signature!.slice(0, 10)}${signature![10] === "A" ? "B" : "A"}${signature!.slice(11)}`;
    for (const session of [
      `owner.${expiry}.${flipped}`,
      `owner.${Number(expiry) + 1}.${signature}`,
      forgedSession(nowSeconds() + 600, "a-different-secret-with-enough-length-000"),
      forgedSession(nowSeconds() - 1),
      forgedSession(nowSeconds() + 43_200 + 3_600),
      accessKey,
      `owner.${expiry}`,
    ]) expect((await app.inject({ method: "GET", url: "/auth/me", headers: cookie(session) })).statusCode, session).toBe(401);
  });

  it("keeps anonymous visitors read-only while public playback keeps working", async () => {
    const { app } = await setup();
    const anonymous = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
    expect((await anonymous("POST", "/videos/uploads", { filename: "x.mp4", contentType: "video/mp4", sizeBytes: 10 })).statusCode).toBe(401);
    expect((await anonymous("DELETE", "/videos/public-film")).statusCode).toBe(401);
    expect((await anonymous("POST", "/social/videos/public-film/comments", { body: "Hello" })).statusCode).toBe(401);
    expect((await anonymous("POST", "/social/videos/public-film/like")).statusCode).toBe(401);
    expect((await anonymous("POST", "/social/videos/public-film/save")).statusCode).toBe(401);
    expect((await anonymous("PATCH", "/social/videos/public-film", { title: "Hijacked", visibility: "private" })).statusCode).toBe(401);
    expect((await anonymous("POST", "/videos/private-film/upload-complete")).statusCode).toBe(401);
    expect((await anonymous("GET", "/videos")).statusCode).toBe(401);
    expect((await anonymous("GET", "/videos/private-film")).statusCode).toBe(401);
    expect((await anonymous("GET", "/social/notifications")).statusCode).toBe(401);
    expect((await anonymous("GET", "/social/saved")).statusCode).toBe(401);
    expect((await anonymous("POST", "/social/playlists", { title: "Mine now" })).statusCode).toBe(401);
    expect((await anonymous("GET", "/social/videos/private-film")).statusCode).toBe(404);
    expect((await anonymous("GET", "/streams/private-film/master.m3u8")).statusCode).toBe(404);

    const feed = await anonymous("GET", "/social/feed");
    expect(feed.statusCode).toBe(200);
    expect(feed.json().videos.map((video: { id: string }) => video.id)).toEqual(["public-film"]);
    expect((await anonymous("GET", "/social/videos/public-film")).statusCode).toBe(200);
    expect((await anonymous("POST", "/social/videos/public-film/view")).statusCode).toBe(200);
    const stream = await anonymous("GET", "/streams/public-film/master.m3u8");
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["cache-control"]).toContain("public");
    expect((await anonymous("GET", "/social/profiles/local-development")).statusCode).toBe(200);
  });

  it("lets the owner manage private videos with the session cookie", async () => {
    const { app } = await setup();
    const signedIn = await app.inject({ method: "POST", url: "/auth/session", headers: ownerHeaders });
    const headers = cookie(/^vp_session=([^;]+)/.exec(String(signedIn.headers["set-cookie"]))![1]!);
    expect((await app.inject({ method: "GET", url: "/videos", headers })).json().videos).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: "/streams/private-film/master.m3u8", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/videos/uploads", headers, payload: { filename: "new.mp4", contentType: "video/mp4", sizeBytes: 10 } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/social/videos/public-film/comments", headers, payload: { body: "Director's note" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "DELETE", url: "/videos/private-film", headers })).statusCode).toBe(204);
  });
});

describe("GET /auth/config", () => {
  let root = "";
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); if (root) await rm(root, { recursive: true, force: true }); });

  it("describes each authentication mode", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "auth-config-"));
    const configFor = async (database: string, extra: Partial<AppConfig>) => {
      const app = await buildApp({ config: { ...baseConfig(root, database), ...extra }, storage: new FakeObjectStorage(), submitter: { submit: async () => ({ runId: "run" }) } });
      apps.push(app);
      return (await app.inject({ method: "GET", url: "/auth/config" })).json();
    };
    expect(await configFor("local.db", {})).toEqual({ enabled: false, mode: "local" });
    expect(await configFor("supabase.db", { supabase: { url: "https://example.supabase.co", anonKey: "public-anon-key" } })).toEqual({ enabled: true, mode: "supabase", url: "https://example.supabase.co", anonKey: "public-anon-key" });
    expect(await configFor("owner.db", { owner })).toEqual({ enabled: true, mode: "owner" });
  });
});

describe("OwnerAccess sessions", () => {
  it("are valid until their expiry and never longer than the configured maximum age", () => {
    let now = 1_700_000_000_000;
    const access = new OwnerAccess({ ...owner, sessionMaxAgeSeconds: 60 }, () => now);
    const session = access.createSession();
    expect(session).toBe(forgedSession(1_700_000_060));
    expect(access.verifySession(session)).toBe(true);
    now += 59_000;
    expect(access.verifySession(session)).toBe(true);
    now += 1_000;
    expect(access.verifySession(session)).toBe(false);
    expect(new OwnerAccess({ ...owner, sessionMaxAgeSeconds: 30 }, () => 1_700_000_000_000).verifySession(session)).toBe(false);
  });

  it("checks the access key by digest only", () => {
    const access = new OwnerAccess(owner);
    expect(access.verifyAccessKey(accessKey)).toBe(true);
    expect(access.verifyAccessKey(`${accessKey} `)).toBe(false);
    expect(access.verifyAccessKey("")).toBe(false);
  });
});
