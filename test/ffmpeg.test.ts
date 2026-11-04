import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeRendition, generateMasterPlaylist, probeVideo, readPlaylist, runProcess } from "../src/services/ffmpeg.js";

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
});
