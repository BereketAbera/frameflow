import path from "node:path";

export type AuthMode = "local" | "supabase" | "owner";
export type OwnerAuthConfig = { tokenSha256: string; sessionSecret: string; userId: string; sessionMaxAgeSeconds: number };

export type AppConfig = {
  port: number;
  host: string;
  databasePath: string;
  uploadDir: string;
  outputDir: string;
  maxUploadBytes: number;
  reconciliationStaleMinutes: number;
  maxConcurrentEncodes: number;
  workerTempDir: string;
  s3: { endpoint?: string; publicEndpoint?: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean; presignedUploadTtlSeconds: number };
  statusCallbackBaseUrl?: string; workerCallbackSecret: string;
  supabase?: { url: string; anonKey: string };
  owner?: OwnerAuthConfig;
};

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/** Presigned URLs sign the request path, so a public storage endpoint must be a bare origin that is routed to the bucket unchanged. */
function publicOrigin(value: string, name: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error(`${name} must be an http(s) origin such as https://media.example.com`); }
  if (!/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error(`${name} must be an http(s) origin without a path, query, or credentials`);
  return url.origin;
}

/** SHA-256 of zero bytes: what hashing an empty or missing key file produces. */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** Browsers cap cookie lifetimes at 400 days, so a longer server-side session could never be presented. */
const MAX_OWNER_SESSION_SECONDS = 400 * 24 * 60 * 60;

function ownerConfig(env: NodeJS.ProcessEnv): OwnerAuthConfig {
  const tokenSha256 = (env.OWNER_TOKEN_SHA256 ?? "").trim().toLowerCase(), sessionSecret = env.OWNER_SESSION_SECRET ?? "", userId = (env.OWNER_USER_ID ?? "").trim() || "local-development";
  if (!/^[0-9a-f]{64}$/.test(tokenSha256)) throw new Error("AUTH_MODE=owner requires OWNER_TOKEN_SHA256: the 64-character hex SHA-256 digest of the owner access key");
  if (tokenSha256 === EMPTY_SHA256) throw new Error("OWNER_TOKEN_SHA256 is the digest of an empty input; hash the owner access key itself");
  if (sessionSecret.length < 32) throw new Error("AUTH_MODE=owner requires OWNER_SESSION_SECRET with at least 32 characters");
  if (!/^[\w.:@-]{1,128}$/.test(userId)) throw new Error("OWNER_USER_ID may only contain letters, digits, and _ . : @ -");
  const sessionMaxAgeSeconds = positiveInteger(env.OWNER_SESSION_MAX_AGE_SECONDS, 43_200, "OWNER_SESSION_MAX_AGE_SECONDS");
  if (sessionMaxAgeSeconds > MAX_OWNER_SESSION_SECONDS) throw new Error(`OWNER_SESSION_MAX_AGE_SECONDS must be at most ${MAX_OWNER_SESSION_SECONDS} (400 days)`);
  return { tokenSha256, sessionSecret, userId, sessionMaxAgeSeconds };
}

/** Settings read only by the Hatchet worker and the workflows it registers. */
export type WorkerConfig = {
  slots: number;
  /** When set, at most this many phase-3 runs execute at once; further videos wait in Hatchet's queue. */
  maxConcurrentVideos?: number;
  /** Go-style duration a task may wait to be scheduled before Hatchet fails it, including time spent behind maxConcurrentVideos. */
  scheduleTimeout: string;
  registerLegacyWorkflow: boolean;
  /** Unset fields leave FFmpeg's own thread count and log output unchanged. */
  ffmpeg: { threads?: number; logLevel?: string };
};

const FFMPEG_LOG_LEVELS = ["quiet", "panic", "fatal", "error", "warning", "info", "verbose", "debug", "trace"];

function goDuration(value: string | undefined, fallback: string, name: string): string {
  const text = value?.trim() || fallback;
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!parts || !parts.slice(1).some((part) => Number(part) > 0)) throw new Error(`${name} must be a positive duration such as 12h, 90m, or 1h30m`);
  return text;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const maxConcurrentVideos = env.FRAMEFLOW_MAX_CONCURRENT_VIDEOS?.trim(), threads = env.FFMPEG_THREADS?.trim(), logLevel = env.FFMPEG_LOG_LEVEL?.trim().toLowerCase();
  if (logLevel && !FFMPEG_LOG_LEVELS.includes(logLevel)) throw new Error(`FFMPEG_LOG_LEVEL must be one of ${FFMPEG_LOG_LEVELS.join(", ")}`);
  return {
    slots: positiveInteger(env.FRAMEFLOW_WORKER_SLOTS?.trim(), 2, "FRAMEFLOW_WORKER_SLOTS"),
    ...(maxConcurrentVideos ? { maxConcurrentVideos: positiveInteger(maxConcurrentVideos, 1, "FRAMEFLOW_MAX_CONCURRENT_VIDEOS") } : {}),
    scheduleTimeout: goDuration(env.FRAMEFLOW_SCHEDULE_TIMEOUT, "12h", "FRAMEFLOW_SCHEDULE_TIMEOUT"),
    registerLegacyWorkflow: !/^(false|0)$/i.test(env.FRAMEFLOW_REGISTER_LEGACY_WORKFLOW?.trim() ?? "true"),
    ffmpeg: { ...(threads ? { threads: positiveInteger(threads, 1, "FFMPEG_THREADS") } : {}), ...(logLevel ? { logLevel } : {}) },
  };
}

export function authModeOf(config: Pick<AppConfig, "supabase" | "owner">): AuthMode {
  return config.owner ? "owner" : config.supabase ? "supabase" : "local";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const authMode = (env.AUTH_MODE ?? "").trim().toLowerCase();
  if (!["", "supabase", "owner"].includes(authMode)) throw new Error("AUTH_MODE must be supabase or owner; leave it unset for local development");
  if (authMode === "owner" && (env.SUPABASE_URL || env.SUPABASE_ANON_KEY)) throw new Error("AUTH_MODE=owner cannot be combined with SUPABASE_URL or SUPABASE_ANON_KEY");
  if (Boolean(env.SUPABASE_URL) !== Boolean(env.SUPABASE_ANON_KEY)) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be configured together");
  if (authMode === "supabase" && !env.SUPABASE_URL) throw new Error("AUTH_MODE=supabase requires SUPABASE_URL and SUPABASE_ANON_KEY");
  // Owner secrets without AUTH_MODE=owner would silently fall back to the open local-development mode.
  if (authMode !== "owner" && (env.OWNER_TOKEN_SHA256 || env.OWNER_SESSION_SECRET)) throw new Error("OWNER_TOKEN_SHA256 and OWNER_SESSION_SECRET are only used with AUTH_MODE=owner");
  const owner = authMode === "owner" ? ownerConfig(env) : undefined;
  const dataDir = path.resolve(cwd, "data");
  return {
    port: positiveInteger(env.PORT, 4000, "PORT"),
    host: env.HOST?.trim() || "127.0.0.1",
    databasePath: path.resolve(env.DATABASE_PATH ?? path.join(dataDir, "app.db")),
    uploadDir: path.resolve(env.UPLOAD_DIR ?? path.join(dataDir, "uploads")),
    outputDir: path.resolve(env.OUTPUT_DIR ?? path.join(dataDir, "output")),
    maxUploadBytes: positiveInteger(env.MAX_UPLOAD_BYTES, 500 * 1024 * 1024, "MAX_UPLOAD_BYTES"),
    reconciliationStaleMinutes: positiveInteger(env.RECONCILIATION_STALE_MINUTES, 15, "RECONCILIATION_STALE_MINUTES"),
    maxConcurrentEncodes: positiveInteger(env.MAX_CONCURRENT_ENCODES, 2, "MAX_CONCURRENT_ENCODES"),
    workerTempDir: path.resolve(env.WORKER_TEMP_DIR ?? path.join(cwd, ".worker-tmp")),
    s3: {
      // Empty counts as unset, as for every other setting, and keeps the local MinIO default. AWS S3 takes its regional endpoint URL.
      endpoint: env.S3_ENDPOINT?.trim() || "http://127.0.0.1:9000",
      ...(env.S3_PUBLIC_ENDPOINT?.trim() ? { publicEndpoint: publicOrigin(env.S3_PUBLIC_ENDPOINT, "S3_PUBLIC_ENDPOINT") } : {}),
      region: env.S3_REGION || "us-east-1", bucket: env.S3_BUCKET || "frameflow",
      accessKeyId: env.S3_ACCESS_KEY_ID || "minioadmin", secretAccessKey: env.S3_SECRET_ACCESS_KEY || "minioadmin",
      forcePathStyle: !/^(false|0)$/i.test(env.S3_FORCE_PATH_STYLE ?? "true"),
      presignedUploadTtlSeconds: positiveInteger(env.S3_PRESIGNED_UPLOAD_TTL_SECONDS, 600, "S3_PRESIGNED_UPLOAD_TTL_SECONDS"),
    },
    statusCallbackBaseUrl:env.STATUS_CALLBACK_BASE_URL,workerCallbackSecret:env.WORKER_CALLBACK_SECRET||"development-worker-secret",
    ...(env.SUPABASE_URL && env.SUPABASE_ANON_KEY ? { supabase: { url: env.SUPABASE_URL.replace(/\/$/, ""), anonKey: env.SUPABASE_ANON_KEY } } : {}),
    ...(owner ? { owner } : {}),
  };
}
