import { VideoRepository } from "../db/video-repository.js";

function withRepository<T>(databasePath: string, operation: (repository: VideoRepository) => T): T {
  const repository = new VideoRepository(databasePath);
  try { return operation(repository); } finally { repository.close(); }
}

export function markWorkflowProcessing(databasePath: string | undefined, videoId: string): void {
  if (databasePath) withRepository(databasePath, (repository) => repository.markProcessing(videoId));
}

export function markWorkflowCompleted(
  databasePath: string | undefined,
  videoId: string,
  masterPlaylistPath: string,
): void {
  if (databasePath) withRepository(databasePath, (repository) => repository.markCompleted(videoId, masterPlaylistPath));
}

export function sanitizeWorkflowFailure(errors: Record<string, string>): { code: string; message: string } {
  const joined = Object.values(errors).join(" ");
  if (/at least 1280x720|requires at least 1280x720/i.test(joined)) {
    return { code: "SOURCE_TOO_SMALL", message: "The source video must be at least 1280x720." };
  }
  if (/decodable video stream|invalid video|ffprobe returned invalid|unsupported ffprobe/i.test(joined)) {
    return { code: "INVALID_VIDEO", message: "The uploaded file is not a supported MP4 video." };
  }
  return { code: "PROCESSING_FAILED", message: "Video processing failed. Check the worker logs using the stored Hatchet run ID." };
}

export function markWorkflowFailed(
  databasePath: string | undefined,
  videoId: string,
  errors: Record<string, string>,
): void {
  if (!databasePath) return;
  const safe = sanitizeWorkflowFailure(errors);
  withRepository(databasePath, (repository) => repository.markFailed(videoId, safe.code, safe.message));
}
