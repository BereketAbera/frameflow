import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeRendition, generateMasterPlaylist, probeVideo, readPlaylist, renditionArgs, runProcess } from "../src/services/ffmpeg.js";

describe("FFmpeg HLS pipeline", () => {
  let tempRoot: string;
  let inputPath: string;
  let outputRoot: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "frameflow-"));
    inputPath = path.join(tempRoot, "sample.mp4");
    outputRoot = path.join(tempRoot, "output");
    await runProcess("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
      "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", inputPath,
    ], () => undefined);
  }, 60_000);

  afterAll(async () => { await rm(tempRoot, { recursive: true, force: true }); });

  it("probes typed metadata", async () => {
    const metadata = await probeVideo(inputPath, () => undefined);
    expect(metadata).toMatchObject({ width: 1280, height: 720, videoCodec: "h264", hasAudio: true, audioCodec: "aac" });
    expect(metadata.durationSeconds).toBeGreaterThan(4);
    expect(metadata.frameRate).toBeCloseTo(30);
  });

  it("encodes parallel renditions, publishes a master playlist, and is playable", async () => {
    const [low, high] = await Promise.all([
      encodeRendition({ inputPath, outputRoot, rendition: "360p", hasAudio: true, log: () => undefined }),
      encodeRendition({ inputPath, outputRoot, rendition: "720p", hasAudio: true, log: () => undefined }),
    ]);
    const master = await generateMasterPlaylist(outputRoot, [low, high]);
    const content = await readPlaylist(master);
    expect(content).toContain("RESOLUTION=640x360");
    expect(content).toContain("360p/index.m3u8");
    expect(content).toContain("RESOLUTION=1280x720");
    expect(content).toContain("720p/index.m3u8");
    expect((await readdir(path.join(outputRoot, "360p"))).some((name) => name.endsWith(".ts"))).toBe(true);
    expect((await readdir(path.join(outputRoot, "720p"))).some((name) => name.endsWith(".ts"))).toBe(true);
    const validation = await runProcess("ffprobe", ["-v", "error", "-show_entries", "format=format_name", "-of", "default=nw=1", master], () => undefined);
    expect(validation).toContain("format_name=hls");
  }, 120_000);

  it("keeps today's encoder arguments unless thread or log limits are set", () => {
    const base = { inputPath: "/in/source.mp4", outputDir: "/out/.720p-attempt", rendition: "720p" as const, hasAudio: true };
    expect(renditionArgs(base)).toEqual([
      "-hide_banner", "-y", "-i", "/in/source.mp4", "-map", "0:v:0", "-map", "0:a:0",
      "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-b:v", "2800k", "-maxrate", "2996k", "-bufsize", "4200k",
      "-force_key_frames", "expr:gte(t,n_forced*4)", "-sc_threshold", "0", "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod", "-hls_flags", "independent_segments",
      "-hls_segment_filename", path.join("/out/.720p-attempt", "segment-%03d.ts"), path.join("/out/.720p-attempt", "index.m3u8"),
    ]);
    const limited = renditionArgs({ ...base, threads: 2, logLevel: "error" });
    expect(limited.slice(0, 5)).toEqual(["-hide_banner", "-nostats", "-loglevel", "error", "-y"]);
    expect(limited.slice(limited.indexOf("-threads"), limited.indexOf("-threads") + 2)).toEqual(["-threads", "2"]);
    expect(limited.indexOf("-threads")).toBeGreaterThan(limited.indexOf("-i"));
  });

  it("encodes quietly with a capped thread count", async () => {
    const lines: string[] = [];
    const rendition = await encodeRendition({ inputPath, outputRoot: path.join(tempRoot, "limited"), rendition: "360p", hasAudio: true, threads: 1, logLevel: "error", log: (line) => lines.push(line) });
    expect(lines).toEqual([]);
    expect(await readPlaylist(rendition.playlistPath)).toContain("#EXTINF");
  }, 120_000);
});
