import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authModeOf, loadConfig, loadWorkerConfig } from "../src/config.js";

const env = (vars: Record<string, string> = {}) => vars as unknown as NodeJS.ProcessEnv;

describe("configuration", () => {
  it("binds the API to loopback unless HOST is set", () => {
    expect(loadConfig(env()).host).toBe("127.0.0.1");
    expect(loadConfig(env({ HOST: "" })).host).toBe("127.0.0.1");
    expect(loadConfig(env({ HOST: "0.0.0.0" })).host).toBe("0.0.0.0");
  });

  it("defaults S3_ENDPOINT only when it is absent", () => {
    expect(loadConfig(env()).s3.endpoint).toBe("http://127.0.0.1:9000");
    expect(loadConfig(env({ S3_ENDPOINT: "http://frameflow-minio:9000" })).s3.endpoint).toBe("http://frameflow-minio:9000");
    expect(loadConfig(env({ S3_ENDPOINT: "" })).s3.endpoint).toBeUndefined();
  });

  it("accepts S3_PUBLIC_ENDPOINT only as a bare origin", () => {
    expect(loadConfig(env()).s3.publicEndpoint).toBeUndefined();
    expect(loadConfig(env({ S3_PUBLIC_ENDPOINT: "https://frameflow.bereket.dev/" })).s3.publicEndpoint).toBe("https://frameflow.bereket.dev");
    expect(() => loadConfig(env({ S3_PUBLIC_ENDPOINT: "https://frameflow.bereket.dev/storage" }))).toThrow(/without a path/);
    expect(() => loadConfig(env({ S3_PUBLIC_ENDPOINT: "frameflow.bereket.dev" }))).toThrow(/S3_PUBLIC_ENDPOINT/);
  });

  describe("AUTH_MODE", () => {
    const supabase = { SUPABASE_URL: "https://example.supabase.co/", SUPABASE_ANON_KEY: "public-anon-key" };
    const owner = { AUTH_MODE: "owner", OWNER_TOKEN_SHA256: "A".repeat(64), OWNER_SESSION_SECRET: "x".repeat(32) };

    it("keeps today's automatic selection when unset", () => {
      expect(authModeOf(loadConfig(env()))).toBe("local");
      expect(loadConfig(env(supabase)).supabase).toEqual({ url: "https://example.supabase.co", anonKey: "public-anon-key" });
      expect(authModeOf(loadConfig(env(supabase)))).toBe("supabase");
    });

    it("requires the Supabase variables for AUTH_MODE=supabase", () => {
      expect(() => loadConfig(env({ AUTH_MODE: "supabase" }))).toThrow(/AUTH_MODE=supabase requires/);
      expect(authModeOf(loadConfig(env({ AUTH_MODE: "supabase", ...supabase })))).toBe("supabase");
    });

    it("loads owner mode with defaults and fails fast when it is misconfigured", () => {
      expect(loadConfig(env(owner)).owner).toEqual({ tokenSha256: "a".repeat(64), sessionSecret: "x".repeat(32), userId: "local-development", sessionMaxAgeSeconds: 43_200 });
      expect(loadConfig(env({ ...owner, OWNER_USER_ID: "owner-1", OWNER_SESSION_MAX_AGE_SECONDS: "3600" })).owner).toMatchObject({ userId: "owner-1", sessionMaxAgeSeconds: 3600 });
      expect(() => loadConfig(env({ ...owner, OWNER_TOKEN_SHA256: "" }))).toThrow(/OWNER_TOKEN_SHA256/);
      expect(() => loadConfig(env({ ...owner, OWNER_TOKEN_SHA256: "a".repeat(63) }))).toThrow(/OWNER_TOKEN_SHA256/);
      expect(() => loadConfig(env({ ...owner, OWNER_TOKEN_SHA256: "g".repeat(64) }))).toThrow(/OWNER_TOKEN_SHA256/);
      expect(() => loadConfig(env({ ...owner, OWNER_SESSION_SECRET: "x".repeat(31) }))).toThrow(/OWNER_SESSION_SECRET/);
      expect(() => loadConfig(env({ ...owner, OWNER_USER_ID: "../owner" }))).toThrow(/OWNER_USER_ID/);
      expect(() => loadConfig(env({ ...owner, OWNER_SESSION_MAX_AGE_SECONDS: "0" }))).toThrow(/OWNER_SESSION_MAX_AGE_SECONDS/);
      expect(loadConfig(env({ ...owner, OWNER_SESSION_MAX_AGE_SECONDS: String(400 * 86_400) })).owner?.sessionMaxAgeSeconds).toBe(34_560_000);
      expect(() => loadConfig(env({ ...owner, OWNER_SESSION_MAX_AGE_SECONDS: String(400 * 86_400 + 1) }))).toThrow(/at most 34560000/);
      expect(() => loadConfig(env({ ...owner, OWNER_TOKEN_SHA256: createHash("sha256").update("").digest("hex") }))).toThrow(/empty input/);
      expect(() => loadConfig(env({ ...owner, ...supabase }))).toThrow(/cannot be combined/);
      expect(() => loadConfig(env({ ...owner, SUPABASE_URL: supabase.SUPABASE_URL }))).toThrow(/cannot be combined/);
      expect(authModeOf(loadConfig(env({ ...owner, AUTH_MODE: " Owner " })))).toBe("owner");
    });

    it("rejects unknown modes and owner secrets without owner mode", () => {
      expect(() => loadConfig(env({ AUTH_MODE: "public" }))).toThrow(/AUTH_MODE must be/);
      expect(() => loadConfig(env({ AUTH_MODE: "local" }))).toThrow(/AUTH_MODE must be/);
      expect(() => loadConfig(env({ OWNER_TOKEN_SHA256: owner.OWNER_TOKEN_SHA256 }))).toThrow(/only used with AUTH_MODE=owner/);
      expect(() => loadConfig(env({ AUTH_MODE: "supabase", ...supabase, OWNER_SESSION_SECRET: owner.OWNER_SESSION_SECRET }))).toThrow(/only used with AUTH_MODE=owner/);
    });
  });

  describe("worker settings", () => {
    it("keeps today's worker when nothing is set", () => {
      expect(loadWorkerConfig(env())).toEqual({ slots: 2, scheduleTimeout: "12h", registerLegacyWorkflow: true });
    });

    it("reads slots, the video concurrency limit, and legacy registration", () => {
      expect(loadWorkerConfig(env({ FRAMEFLOW_WORKER_SLOTS: "1", FRAMEFLOW_MAX_CONCURRENT_VIDEOS: "1", FRAMEFLOW_REGISTER_LEGACY_WORKFLOW: "false" }))).toEqual({ slots: 1, maxConcurrentVideos: 1, scheduleTimeout: "12h", registerLegacyWorkflow: false });
      expect(loadWorkerConfig(env({ FRAMEFLOW_WORKER_SLOTS: "", FRAMEFLOW_MAX_CONCURRENT_VIDEOS: " " })).slots).toBe(2);
      expect(loadWorkerConfig(env({ FRAMEFLOW_MAX_CONCURRENT_VIDEOS: " " })).maxConcurrentVideos).toBeUndefined();
      expect(loadWorkerConfig(env({ FRAMEFLOW_REGISTER_LEGACY_WORKFLOW: "FALSE" })).registerLegacyWorkflow).toBe(false);
      expect(loadWorkerConfig(env({ FRAMEFLOW_REGISTER_LEGACY_WORKFLOW: "true" })).registerLegacyWorkflow).toBe(true);
      for (const [name, value] of [["FRAMEFLOW_WORKER_SLOTS", "0"], ["FRAMEFLOW_WORKER_SLOTS", "two"], ["FRAMEFLOW_MAX_CONCURRENT_VIDEOS", "0"], ["FRAMEFLOW_MAX_CONCURRENT_VIDEOS", "1.5"]] as const) {
        expect(() => loadWorkerConfig(env({ [name]: value })), `${name}=${value}`).toThrow(new RegExp(name));
      }
    });

    it("defaults the schedule timeout to 12h and accepts Go-style durations", () => {
      expect(loadWorkerConfig(env()).scheduleTimeout).toBe("12h");
      expect(loadWorkerConfig(env({ FRAMEFLOW_SCHEDULE_TIMEOUT: "" })).scheduleTimeout).toBe("12h");
      expect(loadWorkerConfig(env({ FRAMEFLOW_SCHEDULE_TIMEOUT: " 1h30m " })).scheduleTimeout).toBe("1h30m");
      for (const value of ["0h", "0h0m", "12", "1d", "-5m", "1.5h", "h", "5m 30s"]) expect(() => loadWorkerConfig(env({ FRAMEFLOW_SCHEDULE_TIMEOUT: value })), value).toThrow(/FRAMEFLOW_SCHEDULE_TIMEOUT/);
    });
  });
});
