import { randomUUID } from "node:crypto";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { migrateDatabase } from "../db/migrate.js";
import { VideoRepository, type VideoRecord } from "../db/video-repository.js";
import { SocialRepository } from "../db/social-repository.js";
import type { WorkflowSubmitter } from "../services/workflow-submitter.js";
import { tokenFromRequest, type AuthUser, type AuthVerifier } from "../services/auth.js";
import type { ObjectStorage } from "../storage/object-storage.js";
import { videoObjectKeys } from "../storage/object-storage.js";
import { ApiError } from "./errors.js";

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
  const social = new SocialRepository(config.databasePath);
  const app = Fastify({ logger });
  app.addHook("onClose", async () => { repository.close(); social.close(); });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    app.log.error(error);
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } });
  });

  const optionalUser = async (request: FastifyRequest): Promise<AuthUser | null> => {
    if (!config.supabase) return { id: "local-development", email: "local@video.local" };
    const token = tokenFromRequest({ authorization: request.headers.authorization, cookie: request.headers.cookie });
    if (!token || !authVerifier) return null;
    const user = await authVerifier.verify(token);
    return user ?? null;
  };
  const requireUser = async (request: FastifyRequest): Promise<AuthUser> => {
    const user = await optionalUser(request);
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    return user;
  };

  app.get("/auth/config", async () => ({ enabled: Boolean(config.supabase), url: config.supabase?.url, anonKey: config.supabase?.anonKey }));
  app.get("/auth/me", async (request) => requireUser(request));
  app.post("/auth/session", async (request, reply) => {
    if (!config.supabase) return { user: await requireUser(request) };
    const token = tokenFromRequest({ authorization: request.headers.authorization, cookie: request.headers.cookie });
    if (!token || !authVerifier) throw new ApiError(401, "UNAUTHENTICATED", "A valid Supabase access token is required.");
    const user = await authVerifier.verify(token);
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Your session is invalid or expired.");
    reply.header("set-cookie", `vp_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
    return { user };
  });
  app.delete("/auth/session", async (_request, reply) => {
    reply.header("set-cookie", "vp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return { signedOut: true };
  });

  app.get("/social/feed", async () => ({ videos: social.publicVideos(), featured: social.featured() }));
  app.get<{ Params:{id:string} }>("/social/videos/:id", async (request) => {
    const user = await optionalUser(request);
    const video = social.detail(request.params.id, user?.id);
    if (!video) throw new ApiError(404,"VIDEO_NOT_FOUND","Video not found.");
    return { video, comments: social.comments(request.params.id) };
  });
  app.patch<{ Params:{id:string};Body:{title?:string;description?:string;tags?:string;visibility?:string} }>("/social/videos/:id",async(request)=>{const user=await requireUser(request),body=request.body??{};if(!body.title?.trim()||!['public','unlisted','private'].includes(body.visibility??''))throw new ApiError(400,'INVALID_VIDEO_METADATA','Title and visibility are required.');if(!social.updateVideo(request.params.id,user.id,{title:body.title.trim().slice(0,120),description:(body.description??'').trim().slice(0,2000),tags:(body.tags??'').trim().slice(0,300),visibility:body.visibility!}))throw new ApiError(404,'VIDEO_NOT_FOUND','Video not found.');return social.detail(request.params.id,user.id);});
  app.post<{Params:{id:string}}>("/social/videos/:id/view",async(request)=>{const user=await optionalUser(request);if(!social.canAccess(request.params.id,user?.id))throw new ApiError(404,'VIDEO_NOT_FOUND','Video not found.');social.view(request.params.id);return{viewed:true};});
  app.post<{Params:{id:string}}>("/social/videos/:id/like",async(request)=>{const user=await requireUser(request),liked=social.toggle('video_likes',request.params.id,user.id);if(liked===null)throw new ApiError(404,'VIDEO_NOT_FOUND','Video not found.');const owner=social.owner(request.params.id);if(liked&&owner&&owner!==user.id)social.notify(owner,'like','Someone liked your video.',`/watch/${request.params.id}`);return{liked};});
  app.post<{Params:{id:string}}>("/social/videos/:id/save",async(request)=>{const user=await requireUser(request),saved=social.toggle('saved_videos',request.params.id,user.id);if(saved===null)throw new ApiError(404,'VIDEO_NOT_FOUND','Video not found.');return{saved};});
  app.post<{Params:{id:string};Body:{body?:string;parentId?:string}}>("/social/videos/:id/comments",async(request,reply)=>{const user=await requireUser(request),body=request.body?.body?.trim();if(!body||body.length>1000)throw new ApiError(400,'INVALID_COMMENT','Comment must be between 1 and 1000 characters.');social.ensureProfile(user.id,user.email);const id=social.addComment(request.params.id,user.id,body,request.body.parentId);if(!id)throw new ApiError(404,'VIDEO_OR_PARENT_NOT_FOUND','Video or parent comment not found.');const owner=social.owner(request.params.id);if(owner&&owner!==user.id)social.notify(owner,'comment','Someone commented on your video.',`/watch/${request.params.id}`);return reply.status(201).send({id});});
  app.patch<{Params:{id:string};Body:{body?:string}}>("/social/comments/:id",async(request)=>{const user=await requireUser(request),body=request.body?.body?.trim();if(!body||body.length>1000)throw new ApiError(400,'INVALID_COMMENT','Comment must be between 1 and 1000 characters.');if(!social.updateComment(request.params.id,user.id,body))throw new ApiError(404,'COMMENT_NOT_FOUND','Comment not found.');return{updated:true};});
  app.delete<{Params:{id:string}}>("/social/comments/:id",async(request,reply)=>{const user=await requireUser(request);if(!social.deleteComment(request.params.id,user.id))throw new ApiError(404,'COMMENT_NOT_FOUND','Comment not found.');return reply.status(204).send();});
  app.get<{Params:{id:string}}>("/social/profiles/:id",async(request)=>{const profile=social.profile(request.params.id);if(!profile)throw new ApiError(404,'PROFILE_NOT_FOUND','Creator not found.');return profile;});
  app.get("/social/playlists",async(request)=>{const user=await requireUser(request);return{playlists:social.playlists(user.id)};});
  app.post<{Body:{title?:string}}>("/social/playlists",async(request,reply)=>{const user=await requireUser(request),title=request.body?.title?.trim();if(!title)throw new ApiError(400,'INVALID_TITLE','Playlist title is required.');return reply.status(201).send({id:social.createPlaylist(user.id,title.slice(0,80))});});
  app.post<{Params:{id:string;videoId:string}}>("/social/playlists/:id/videos/:videoId",async(request,reply)=>{const user=await requireUser(request);if(!social.addToPlaylist(request.params.id,request.params.videoId,user.id))throw new ApiError(404,'PLAYLIST_OR_VIDEO_NOT_FOUND','Playlist or video not found.');return reply.status(204).send();});
  app.get("/social/saved",async(request)=>{const user=await requireUser(request);return{videos:social.saved(user.id)};});
  app.get("/social/notifications",async(request)=>{const user=await requireUser(request);return{notifications:social.notifications(user.id)};});
  app.post("/social/notifications/read",async(request)=>{const user=await requireUser(request);social.markNotificationsRead(user.id);return{read:true};});

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
  app.delete<{ Params: { id: string } }>("/videos/:id", async (request, reply) => {
    const user = await requireUser(request);
    const record = repository.getOwned(request.params.id, user.id);
    if (!record) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video not found.");
    if (!["completed", "failed"].includes(record.status)) throw new ApiError(409, "VIDEO_ACTIVE", "A video cannot be deleted while processing is active.");
    await storage.deletePrefix(videoObjectKeys(record.id).root);
    repository.deleteOwned(record.id, user.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { videoId: string; "*": string } }>("/streams/:videoId/*", async (request, reply) => {
    const user = await optionalUser(request);
    const record = repository.get(request.params.videoId);
    const access = record ? social.detail(record.id,user?.id) as { visibility: string } | null : null;
    if (!record || !access) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video not found.");
    if (record.status !== "completed") throw new ApiError(404, "STREAM_NOT_READY", "The stream is not available yet.");
    const key = streamKey(record, request.params["*"]);
    try {
      const object = await storage.getObjectStream(key);
      const cacheControl = access.visibility === "public" ? (key.endsWith(".ts") ? "public,max-age=31536000,immutable" : "public,max-age=60") : "private,no-store";
      reply.type(key.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t").header("cache-control", cacheControl).header("access-control-allow-origin", "*");
      if (object.etag) reply.header("etag", object.etag);
      return reply.send(object.stream);
    } catch {
      throw new ApiError(404, "STREAM_FILE_NOT_FOUND", "Stream file not found.");
    }
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
      return { status: "ready", database: "ok", storage: "ok", workflow: "configured" };
    } catch {
      return reply.status(503).send({ status: "not_ready", database: "unknown", storage: "unavailable" });
    }
  });
  app.get("/health", async (_request, reply) => reply.redirect("/health/ready"));
  return app;
}
