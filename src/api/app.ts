import { randomUUID } from "node:crypto";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { migrateDatabase } from "../db/migrate.js";
import { VideoRepository, type VideoRecord } from "../db/video-repository.js";
import type { WorkflowSubmitter } from "../services/workflow-submitter.js";
import { tokenFromRequest, type AuthUser, type AuthVerifier } from "../services/auth.js";
import type { ObjectStorage } from "../storage/object-storage.js";
import { videoObjectKeys } from "../storage/object-storage.js";
import { dashboardHtml } from "./dashboard.js";
import { ApiError } from "./errors.js";
import { playerHtml } from "./player.js";

export type AppDependencies = { config: AppConfig; submitter: WorkflowSubmitter; storage: ObjectStorage; authVerifier?: AuthVerifier; logger?: boolean };
const completionLocks = new Map<string, Promise<VideoRecord>>();

export function publicVideo(record: VideoRecord) {
  return {
    id: record.id,
    originalFilename: record.originalFilename,
    status: record.status,
    uploadStatus: record.uploadStatus,
    sizeBytes: record.sourceSizeBytes ?? record.declaredSizeBytes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    processingStartedAt: record.processingStartedAt,
    processingCompletedAt: record.processingCompletedAt,
    playerUrl: `/player/${record.id}`,
    ...(record.status === "completed" ? { playbackUrl: `/streams/${record.id}/master.m3u8` } : {}),
    ...(record.status === "failed" ? { error: { code: record.errorCode ?? "PROCESSING_FAILED", message: record.errorMessage ?? "Video processing failed." } } : {}),
  };
}

function streamKey(record: VideoRecord, relativePath: string): string {
  const allowed = /^(?:master\.m3u8|(?:360p|720p)\/(?:index\.m3u8|segment-\d{3,}\.ts))$/;
  if (!record.outputPrefix || !allowed.test(relativePath)) throw new ApiError(400, "INVALID_STREAM_PATH", "Invalid stream path.");
  return `${record.outputPrefix}/${relativePath}`;
}

export async function buildApp({ config, submitter, storage, authVerifier, logger = false }: AppDependencies): Promise<FastifyInstance> {
  await migrateDatabase(config.databasePath);
  const repository = new VideoRepository(config.databasePath);
  const app = Fastify({ logger });
  app.addHook("onClose", async () => repository.close());
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    app.log.error(error);
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } });
  });

  const requireUser = async (request: FastifyRequest): Promise<AuthUser> => {
    if (!config.supabase) return { id: "local-development", email: "local@video.local" };
    const token = tokenFromRequest({ authorization: request.headers.authorization, cookie: request.headers.cookie });
    if (!token || !authVerifier) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    const user = await authVerifier.verify(token);
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Your session is invalid or expired.");
    return user;
  };

  app.get("/", async (_request, reply) => reply.type("text/html").send(dashboardHtml(config.maxUploadBytes)));
  app.get("/upload", async (_request, reply) => reply.redirect("/"));
  app.get("/auth/config", async () => ({ enabled: Boolean(config.supabase), url: config.supabase?.url, anonKey: config.supabase?.anonKey }));
  app.get("/auth/me", async (request) => requireUser(request));
  app.post("/auth/session", async (request, reply) => {
    if (!config.supabase) return { user: await requireUser(request) };
    const token = tokenFromRequest({ authorization: request.headers.authorization, cookie: request.headers.cookie });
    if (!token || !authVerifier) throw new ApiError(401, "UNAUTHENTICATED", "A valid Supabase access token is required.");
    const user = await authVerifier.verify(token);
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Your session is invalid or expired.");
    reply.header("set-cookie", `vp_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`);
    return { user };
  });
  app.delete("/auth/session", async (_request, reply) => {
    reply.header("set-cookie", "vp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return { signedOut: true };
  });

  app.post<{ Body: { filename?: string; contentType?: string; sizeBytes?: number } }>("/videos/uploads", async (request, reply) => {
    const user = await requireUser(request);
    const body = request.body ?? {};
    if (!body.filename || path.extname(body.filename).toLowerCase() !== ".mp4" || body.contentType !== "video/mp4") throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Only MP4 uploads are supported.");
    if (!Number.isSafeInteger(body.sizeBytes) || body.sizeBytes! <= 0) throw new ApiError(400, "INVALID_SIZE", "A positive integer sizeBytes is required.");
    if (body.sizeBytes! > config.maxUploadBytes) throw new ApiError(413, "UPLOAD_TOO_LARGE", "The declared upload exceeds the configured size limit.");

    const id = randomUUID();
    const keys = videoObjectKeys(id);
    const expiresAt = new Date(Date.now() + config.s3.presignedUploadTtlSeconds * 1000).toISOString();
    repository.createPendingUpload({ id, userId: user.id, originalFilename: path.basename(body.filename).slice(0, 255), sourceObjectKey: keys.source, outputPrefix: keys.outputPrefix, sizeBytes: body.sizeBytes!, expiresAt });
    try {
      const upload = await storage.createPresignedUploadUrl({ key: keys.source, contentType: "video/mp4", expiresInSeconds: config.s3.presignedUploadTtlSeconds });
      return reply.status(201).send({ videoId: id, upload, completeUrl: `/videos/${id}/upload-complete`, statusUrl: `/videos/${id}` });
    } catch {
      repository.markFailed(id, "STORAGE_UNAVAILABLE", "Upload storage is unavailable.");
      throw new ApiError(503, "STORAGE_UNAVAILABLE", "Upload storage is unavailable.");
    }
  });

  const completeUpload = async (id: string): Promise<VideoRecord> => {
    const existing = repository.require(id);
    if (["queued", "processing", "completed", "failed"].includes(existing.status)) return existing;
    if (existing.uploadExpiresAt && existing.uploadExpiresAt < new Date().toISOString()) {
      repository.markUploadExpired(id);
      throw new ApiError(410, "UPLOAD_EXPIRED", "The upload authorization expired.");
    }
    const metadata = await storage.headObject(existing.sourceObjectKey!);
    if (!metadata) throw new ApiError(409, "UPLOAD_MISSING", "The uploaded object was not found.");
    if (!metadata.contentLength || metadata.contentLength > config.maxUploadBytes || metadata.contentLength !== existing.declaredSizeBytes) {
      repository.markFailed(id, "UPLOAD_SIZE_MISMATCH", "The uploaded object size does not match the declared size.");
      throw new ApiError(400, "UPLOAD_SIZE_MISMATCH", "The uploaded object size does not match the declared size.");
    }
    repository.markObjectUploaded(id, { etag: metadata.etag, sizeBytes: metadata.contentLength });
    try {
      const run = await submitter.submit({
        videoId: id,
        sourceObjectKey: existing.sourceObjectKey!,
        outputPrefix: existing.outputPrefix!,
        ...(/^(true|1)$/i.test(process.env.FORCE_720P_FAILURE_ONCE ?? "") ? { force720pFailureOnce: true } : {}),
      });
      return repository.markQueued(id, run.runId);
    } catch {
      repository.markFailed(id, "HATCHET_SUBMISSION_FAILED", "The video could not be queued for processing.");
      throw new ApiError(503, "HATCHET_SUBMISSION_FAILED", "The video could not be queued for processing.");
    }
  };

  app.post<{ Params: { id: string } }>("/videos/:id/upload-complete", async (request, reply) => {
    const user = await requireUser(request);
    if (!repository.getOwned(request.params.id, user.id)) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video not found.");
    let completion = completionLocks.get(request.params.id);
    if (!completion) {
      completion = completeUpload(request.params.id).finally(() => completionLocks.delete(request.params.id));
      completionLocks.set(request.params.id, completion);
    }
    const record = await completion;
    return reply.status(202).send({ ...publicVideo(record), hatchetRunId: record.hatchetRunId, statusUrl: `/videos/${record.id}` });
  });

  app.get<{ Params: { id: string } }>("/videos/:id", async (request) => {
    const user = await requireUser(request);
    const record = repository.getOwned(request.params.id, user.id);
    if (!record) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video not found.");
    return publicVideo(record);
  });
  app.get<{ Querystring: { limit?: string } }>("/videos", async (request) => {
    const user = await requireUser(request);
    return { videos: repository.listOwned(user.id, Math.min(Math.max(Number(request.query.limit) || 20, 1), 100)).map(publicVideo) };
  });

  app.get<{ Params: { videoId: string; "*": string } }>("/streams/:videoId/*", async (request, reply) => {
    const user = await requireUser(request);
    const record = repository.getOwned(request.params.videoId, user.id);
    if (!record) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video not found.");
    if (record.status !== "completed") throw new ApiError(404, "STREAM_NOT_READY", "The stream is not available yet.");
    const key = streamKey(record, request.params["*"]);
    try {
      const object = await storage.getObjectStream(key);
      reply.type(key.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t").header("cache-control", key.endsWith(".ts") ? "public,max-age=31536000,immutable" : "public,max-age=60").header("access-control-allow-origin", "*");
      if (object.etag) reply.header("etag", object.etag);
      return reply.send(object.stream);
    } catch {
      throw new ApiError(404, "STREAM_FILE_NOT_FOUND", "Stream file not found.");
    }
  });

  app.get<{ Params: { videoId: string } }>("/player/:videoId", async (request, reply) => {
    return reply.type("text/html").send(playerHtml(request.params.videoId));
  });

  app.post<{ Params: { id: string; event: string }; Body: { masterPlaylistObjectKey?: string; code?: string; message?: string } }>("/internal/videos/:id/:event", async (request) => {
    if (request.headers["x-worker-secret"] !== config.workerCallbackSecret) throw new ApiError(403, "FORBIDDEN", "Forbidden.");
    if (request.params.event === "processing") return publicVideo(repository.markProcessing(request.params.id));
    if (request.params.event === "completed") return publicVideo(repository.markObjectCompleted(request.params.id, request.body.masterPlaylistObjectKey!));
    if (request.params.event === "failed") return publicVideo(repository.markFailed(request.params.id, request.body.code ?? "PROCESSING_FAILED", request.body.message ?? "Video processing failed."));
    throw new ApiError(400, "INVALID_EVENT", "Invalid event.");
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      if ("healthcheck" in storage) await (storage as ObjectStorage & { healthcheck(): Promise<void> }).healthcheck();
      repository.healthcheck();
      return { status: "ready", database: "ok", storage: "ok" };
    } catch {
      return reply.status(503).send({ status: "not_ready", database: "unknown", storage: "unavailable" });
    }
  });
  app.get("/health", async (_request, reply) => reply.redirect("/health/ready"));
  return app;
}
