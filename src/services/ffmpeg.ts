import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";

export type VideoMetadata = {
  durationSeconds: number;
  width: number;
  height: number;
  frameRate?: number;
  videoCodec: string;
  audioCodec?: string;
  hasAudio: boolean;
};

export type RenditionName = "360p" | "720p";

export type RenditionResult = {
  name: RenditionName;
  playlistPath: string;
  width: number;
  height: number;
  bandwidth: number;
};

type RenditionConfig = {
  name: RenditionName;
  width: number;
  height: number;
  videoBitrate: string;
  maxRate: string;
  bufferSize: string;
  audioBitrate: string;
  bandwidth: number;
};

const renditionConfigs: Record<RenditionName, RenditionConfig> = {
  "360p": {
    name: "360p", width: 640, height: 360, videoBitrate: "800k",
    maxRate: "856k", bufferSize: "1200k", audioBitrate: "96k", bandwidth: 985_600,
  },
  "720p": {
    name: "720p", width: 1280, height: 720, videoBitrate: "2800k",
    maxRate: "2996k", bufferSize: "4200k", audioBitrate: "128k", bandwidth: 3_220_800,
  },
};

const ffprobeSchema = z.object({
  format: z.object({ duration: z.string().optional() }).passthrough(),
  streams: z.array(z.object({
    codec_type: z.string().optional(),
    codec_name: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    avg_frame_rate: z.string().optional(),
    r_frame_rate: z.string().optional(),
  }).passthrough()),
});

export type ProcessLogger = (message: string) => unknown | Promise<unknown>;

function parseFrameRate(value?: string): number | undefined {
  if (!value || value === "0/0") return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  if (numerator === undefined || denominator === undefined || denominator === 0) return undefined;
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

export async function runProcess(
  command: string,
  args: string[],
  log: ProcessLogger = console.log,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stderrBuffer = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n|\r/);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) void log(line.trim());
      }
    });
    child.on("error", (error) => reject(new Error(`Could not start ${command}: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (stderrBuffer.trim()) void log(stderrBuffer.trim());
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} failed (exit ${code ?? "unknown"}, signal ${signal ?? "none"}):\n${stderr.slice(-8000)}`));
    });
  });
}

export async function probeVideo(inputPath: string, log?: ProcessLogger): Promise<VideoMetadata> {
  const raw = await runProcess("ffprobe", [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", inputPath,
  ], log);
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new Error("ffprobe returned invalid JSON"); }
  const parsed = ffprobeSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Unsupported ffprobe response: ${parsed.error.message}`);

  const video = parsed.data.streams.find((stream) => stream.codec_type === "video");
  const audio = parsed.data.streams.find((stream) => stream.codec_type === "audio");
  const durationSeconds = Number(parsed.data.format.duration);
  if (!video?.width || !video.height || !video.codec_name || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Input must contain a decodable video stream with dimensions, codec, and positive duration");
  }
  if (video.width < 1280 || video.height < 720) {
    throw new Error(`Input is ${video.width}x${video.height}; this POC requires at least 1280x720 to avoid upscaling`);
  }
  const frameRate = parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate);
  return {
    durationSeconds, width: video.width, height: video.height, frameRate,
    videoCodec: video.codec_name, audioCodec: audio?.codec_name, hasAudio: Boolean(audio),
  };
}

async function publishDirectory(tempDir: string, finalDir: string): Promise<void> {
  const backupDir = `${finalDir}.old-${randomUUID()}`;
  let hadExisting = false;
  try {
    try { await rename(finalDir, backupDir); hadExisting = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(tempDir, finalDir);
    if (hadExisting) await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (hadExisting) {
      try { await rename(backupDir, finalDir); } catch { /* preserve original error */ }
    }
    throw error;
  }
}

export async function encodeRendition(options: {
  inputPath: string;
  outputRoot: string;
  rendition: RenditionName;
  hasAudio: boolean;
  log?: ProcessLogger;
}): Promise<RenditionResult> {
  const config = renditionConfigs[options.rendition];
  const finalDir = path.join(options.outputRoot, config.name);
  const tempDir = path.join(options.outputRoot, `.${config.name}-attempt-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });

  const args = ["-hide_banner", "-y", "-i", options.inputPath, "-map", "0:v:0"];
  if (options.hasAudio) args.push("-map", "0:a:0");
  args.push(
    "-vf", `scale=${config.width}:${config.height}:force_original_aspect_ratio=decrease,pad=${config.width}:${config.height}:(ow-iw)/2:(oh-ih)/2`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-b:v", config.videoBitrate, "-maxrate", config.maxRate, "-bufsize", config.bufferSize,
    "-force_key_frames", "expr:gte(t,n_forced*4)", "-sc_threshold", "0",
  );
  if (options.hasAudio) args.push("-c:a", "aac", "-b:a", config.audioBitrate, "-ac", "2");
  args.push(
    "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments", "-hls_segment_filename", path.join(tempDir, "segment-%03d.ts"),
    path.join(tempDir, "index.m3u8"),
  );

  try {
    await runProcess("ffmpeg", args, options.log);
    const playlist = await stat(path.join(tempDir, "index.m3u8"));
    if (!playlist.isFile() || playlist.size === 0) throw new Error("FFmpeg did not produce a non-empty variant playlist");
    await publishDirectory(tempDir, finalDir);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
  return {
    name: config.name, playlistPath: path.join(finalDir, "index.m3u8"),
    width: config.width, height: config.height, bandwidth: config.bandwidth,
  };
}

export async function generateMasterPlaylist(
  outputRoot: string,
  renditions: RenditionResult[],
): Promise<string> {
  const byName = new Map(renditions.map((item) => [item.name, item]));
  const ordered = [byName.get("360p"), byName.get("720p")];
  for (const rendition of ordered) {
    if (!rendition) throw new Error("Both 360p and 720p renditions are required");
    const info = await stat(rendition.playlistPath);
    if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty playlist: ${rendition.playlistPath}`);
  }
  const content = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const rendition of ordered as RenditionResult[]) {
    content.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},RESOLUTION=${rendition.width}x${rendition.height}`,
      `${rendition.name}/index.m3u8`,
    );
  }
  const finalPath = path.join(outputRoot, "master.m3u8");
  const tempPath = `${finalPath}.tmp-${randomUUID()}`;
  await writeFile(tempPath, `${content.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  await rename(tempPath, finalPath);
  return finalPath;
}

export async function readPlaylist(playlistPath: string): Promise<string> {
  return readFile(playlistPath, "utf8");
}
