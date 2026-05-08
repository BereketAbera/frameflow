import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { AppConfig } from "../config.js";
import { migrateDatabase } from "../db/migrate.js";
import { VideoRepository, type VideoRecord } from "../db/video-repository.js";
import type { WorkflowSubmitter } from "../services/workflow-submitter.js";
import { ApiError } from "./errors.js";
import { playerHtml } from "./player.js";

export type AppDependencies = {
  config: AppConfig;
  submitter: WorkflowSubmitter;
  logger?: boolean;
};

const videoIdPattern = /^[a-zA-Z0-9_-]+$/;
const allowedStreamPath = /^(?:master\.m3u8|(?:360p|720p)\/(?:index\.m3u8|segment-\d{3,}\.ts))$/;

function publicVideo(record: VideoRecord): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: record.id, status: record.status, createdAt: record.createdAt,
    processingStartedAt: record.processingStartedAt,
    processingCompletedAt: record.processingCompletedAt,
    playerUrl: `/player/${record.id}`,
  };
  if (record.status === "completed") response.playbackUrl = `/streams/${record.id}/master.m3u8`;
  if (record.status === "failed") response.error = {
    code: record.errorCode ?? "PROCESSING_FAILED",
    message: record.errorMessage ?? "Video processing failed.",
  };
  return response;
}

async function hasMp4Signature(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
  } finally { await handle.close(); }
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, submitter } = dependencies;
  await Promise.all([
    migrateDatabase(config.databasePath),
    mkdir(config.uploadDir, { recursive: true }),
    mkdir(config.outputDir, { recursive: true }),
  ]);
  const repository = new VideoRepository(config.databasePath);
  const app = Fastify({ logger: dependencies.logger ?? false, bodyLimit: config.maxUploadBytes + 1024 * 1024 });
  await app.register(multipart, {
    limits: { files: 2, fileSize: config.maxUploadBytes, parts: 5 },
    throwFileSizeLimit: true,
  });

  app.addHook("onClose", async () => repository.close());
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof app.multipartErrors.RequestFileTooLargeError || (error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.status(413).send({ error: { code: "UPLOAD_TOO_LARGE", message: "The uploaded file exceeds the configured size limit." } });
    }
    app.log.error(error);
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } });
  });

  app.post("/videos", async (request, reply) => {
    if (!request.isMultipart()) throw new ApiError(400, "MISSING_UPLOAD", "A multipart MP4 upload is required.");
    const id = randomUUID();
    const videoDirectory = path.join(config.uploadDir, id);
    const sourcePath = path.join(videoDirectory, "source.mp4");
    const temporaryPath = path.join(videoDirectory, "source.uploading");
    let created = false;
    let fileCount = 0;
    try {
      await mkdir(videoDirectory, { recursive: true });
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        fileCount += 1;
        if (fileCount > 1) throw new ApiError(400, "MULTIPLE_UPLOADS", "Upload exactly one video file.");
        const originalFilename = path.basename(part.filename || "upload.mp4").slice(0, 255);
        repository.createUploading({ id, originalFilename, sourcePath });
        created = true;
        if (part.fieldname !== "video") throw new ApiError(400, "MISSING_UPLOAD", "Use multipart field 'video'.");
        if (path.extname(originalFilename).toLowerCase() !== ".mp4" || part.mimetype !== "video/mp4") {
          throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Only MP4 uploads are supported.");
        }
        await pipeline(part.file, createWriteStream(temporaryPath, { flags: "wx" }));
        if (part.file.truncated) throw new ApiError(413, "UPLOAD_TOO_LARGE", "The uploaded file exceeds the configured size limit.");
      }
      if (fileCount === 0) throw new ApiError(400, "MISSING_UPLOAD", "Upload one MP4 using multipart field 'video'.");
      if (!await hasMp4Signature(temporaryPath)) throw new ApiError(415, "INVALID_VIDEO", "The upload is not an MP4 container.");
      await rename(temporaryPath, sourcePath);
      repository.markUploaded(id);
      let submitted: { runId: string };
      try {
        submitted = await submitter.submit({
          videoId: id, sourcePath, outputBasePath: config.outputDir, databasePath: config.databasePath,
        });
      } catch {
        repository.markFailed(id, "HATCHET_SUBMISSION_FAILED", "The video could not be queued for processing.");
        throw new ApiError(503, "HATCHET_SUBMISSION_FAILED", "The video could not be queued for processing.");
      }
      repository.markQueued(id, submitted.runId);
      return reply.status(202).send({ id, status: "queued", statusUrl: `/videos/${id}`, playerUrl: `/player/${id}` });
    } catch (error) {
      await rm(temporaryPath, { force: true });
      if (created && !(error instanceof ApiError && error.code === "HATCHET_SUBMISSION_FAILED")) {
        const code = error instanceof ApiError ? error.code : "UPLOAD_FAILED";
        const message = error instanceof ApiError ? error.message : "The upload could not be stored.";
        repository.markFailed(id, code, message);
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/videos/:id", async (request) => {
    const record = repository.get(request.params.id);
    if (!record) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video not found.");
    return publicVideo(record);
  });

  app.get<{ Querystring: { limit?: string } }>("/videos", async (request) => {
    const parsed = Number(request.query.limit ?? 20);
    const limit = Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 20;
    return { videos: repository.list(limit).map(publicVideo) };
  });

  app.get<{ Params: { videoId: string; "*": string } }>("/streams/:videoId/*", async (request, reply) => {
    const { videoId } = request.params;
    const relative = request.params["*"];
    if (!videoIdPattern.test(videoId) || !allowedStreamPath.test(relative)) {
      throw new ApiError(400, "INVALID_STREAM_PATH", "Invalid stream path.");
    }
    const record = repository.get(videoId);
    if (!record) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video not found.");
    if (record.status !== "completed") throw new ApiError(404, "STREAM_NOT_READY", "The stream is not available yet.");
    const videoRoot = path.resolve(config.outputDir, videoId);
    const filePath = path.resolve(videoRoot, relative);
    if (!filePath.startsWith(`${videoRoot}${path.sep}`)) throw new ApiError(400, "INVALID_STREAM_PATH", "Invalid stream path.");
    let fileStat;
    try { fileStat = await stat(filePath); } catch { throw new ApiError(404, "STREAM_FILE_NOT_FOUND", "Stream file not found."); }
    if (!fileStat.isFile()) throw new ApiError(404, "STREAM_FILE_NOT_FOUND", "Stream file not found.");
    reply.type(filePath.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
    reply.header("Access-Control-Allow-Origin", "*");
    return reply.send(createReadStream(filePath));
  });

  app.get<{ Params: { videoId: string } }>("/player/:videoId", async (request, reply) => {
    if (!videoIdPattern.test(request.params.videoId)) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video not found.");
    if (!repository.get(request.params.videoId)) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video not found.");
    return reply.type("text/html; charset=utf-8").send(playerHtml(request.params.videoId));
  });

  app.get("/health", async (_request, reply) => {
    try {
      const [uploads, outputs] = await Promise.all([stat(config.uploadDir), stat(config.outputDir)]);
      const healthy = repository.healthcheck() && uploads.isDirectory() && outputs.isDirectory();
      return reply.status(healthy ? 200 : 503).send({ status: healthy ? "ok" : "unhealthy", database: "ok", uploads: "ok", output: "ok" });
    } catch {
      return reply.status(503).send({ status: "unhealthy", database: "unknown", uploads: "unavailable", output: "unavailable" });
    }
  });

  return app;
}
