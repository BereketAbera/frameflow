/**
 * Packaging with the real FFmpeg, on an HLS output produced the way Frameflow's pipeline produces one: per rendition,
 * `-f hls -hls_time 4 -hls_playlist_type vod -hls_flags independent_segments` into <name>/index.m3u8 and
 * <name>/segment-%03d.ts, and a master playlist listing the renditions.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageRelease } from "../src/publisher/package.js";
import { assertMatchesManifest, directorySource, inspectRelease } from "../src/publisher/inspect.js";
import { parseReleaseManifest, serializeReleaseManifest } from "../src/shared/contract.js";

const run = promisify(execFile);
let root: string, hlsDir: string;

async function encode(name: string, width: number, height: number): Promise<void> {
  const directory = path.join(hlsDir, name);
  await mkdir(directory, { recursive: true });
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "9",
    "-map", "0:v:0", "-map", "1:a:0", "-vf", `scale=${width}:${height}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-force_key_frames", "expr:gte(t,n_forced*4)", "-sc_threshold", "0", "-c:a", "aac", "-b:a", "64k", "-ac", "2",
    "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod", "-hls_flags", "independent_segments", "-hls_segment_filename", path.join(directory, "segment-%03d.ts"), path.join(directory, "index.m3u8"),
  ]);
}

const probe = async (file: string, entries: string): Promise<Record<string, any>> => JSON.parse((await run("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "json", file])).stdout);

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "frameflow-package-"));
  hlsDir = path.join(root, "output");
  await encode("360p", 160, 90);
  await encode("720p", 320, 180);
  await writeFile(path.join(hlsDir, "master.m3u8"), ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-STREAM-INF:BANDWIDTH=985600,RESOLUTION=160x90", "360p/index.m3u8", "#EXT-X-STREAM-INF:BANDWIDTH=3220800,RESOLUTION=320x180", "720p/index.m3u8", ""].join("\n"));
  // What a real output directory can also hold, and what must never reach a release.
  await writeFile(path.join(hlsDir, "source.mp4"), "the private original");
  await writeFile(path.join(hlsDir, "720p", "segment-099.ts"), "left over from another run");
}, 120_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("packaging a completed HLS output", () => {
  it("copies what the playlists reference and adds a thumbnail and a muted preview", async () => {
    const outDir = path.join(root, "package-a");
    const manifest = await packageRelease({ hlsDir, outDir, label: "a" });

    expect(manifest.files.map((file) => file.path)).toEqual([
      "360p/index.m3u8", "360p/segment-000.ts", "360p/segment-001.ts", "360p/segment-002.ts",
      "720p/index.m3u8", "720p/segment-000.ts", "720p/segment-001.ts", "720p/segment-002.ts", "master.m3u8", "preview.mp4", "thumbnail.jpg",
    ]);
    expect(manifest.renditions).toEqual([
      { name: "360p", playlist: "360p/index.m3u8", width: 160, height: 90, bandwidth: 985_600, segments: 3 },
      { name: "720p", playlist: "720p/index.m3u8", width: 320, height: 180, bandwidth: 3_220_800, segments: 3 },
    ]);
    expect(manifest.durationSeconds).toBeGreaterThan(8.5);
    expect(manifest.durationSeconds).toBeLessThan(9.5);
    expect(manifest.id).toMatch(/^a-[0-9a-f]{16}$/);
    expect((await readdir(outDir, { recursive: true })).some((file) => /source\.mp4|segment-099/.test(String(file)))).toBe(false);

    // The thumbnail is a frame of the largest rendition.
    const thumbnail = (await probe(path.join(outDir, "thumbnail.jpg"), "stream=codec_name,width,height")).streams;
    expect(thumbnail).toEqual([{ codec_name: "mjpeg", width: 320, height: 180 }]);

    // The preview is a short H.264 clip of the smallest rendition, with no audio track, that can start before it has fully downloaded.
    const preview = await probe(path.join(outDir, "preview.mp4"), "stream=codec_type,codec_name,width,height,pix_fmt:format=duration");
    expect(preview.streams).toEqual([{ codec_type: "video", codec_name: "h264", width: 160, height: 90, pix_fmt: "yuv420p" }]);
    expect(Number(preview.format.duration)).toBeGreaterThan(3.5);
    expect(Number(preview.format.duration)).toBeLessThan(4.5);
    const bytes = await readFile(path.join(outDir, "preview.mp4"));
    expect(bytes.indexOf("moov")).toBeGreaterThan(0);
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));

    // The manifest on disk is canonical and describes exactly the directory.
    const text = await readFile(path.join(outDir, "release.json"), "utf8");
    expect(serializeReleaseManifest(parseReleaseManifest(text))).toBe(text);
    await assertMatchesManifest(await inspectRelease(directorySource(outDir)), manifest, "the package");
  }, 120_000);

  it("gives the same content the same release ID, and honours the thumbnail time and preview length", async () => {
    const first = await packageRelease({ hlsDir, outDir: path.join(root, "package-b1"), label: "b" });
    const second = await packageRelease({ hlsDir, outDir: path.join(root, "package-b2"), label: "b" });
    expect(second.id).toBe(first.id);
    expect(second.files).toEqual(first.files);

    const other = await packageRelease({ hlsDir, outDir: path.join(root, "package-b3"), label: "b", thumbnailAtSeconds: 6, previewSeconds: 2 });
    expect(other.id).not.toBe(first.id);
    const preview = await probe(path.join(root, "package-b3", "preview.mp4"), "format=duration");
    expect(Number(preview.format.duration)).toBeGreaterThan(1.5);
    expect(Number(preview.format.duration)).toBeLessThan(2.5);
  }, 120_000);

  it("never writes into a directory that already holds something", async () => {
    await expect(packageRelease({ hlsDir, outDir: path.join(root, "package-a"), label: "a" })).rejects.toThrow(/not empty/);
    expect(await readdir(path.join(root, "package-a"))).toContain("release.json");
  });

  it("refuses an output with a missing segment and leaves no half-written package behind", async () => {
    const broken = path.join(root, "broken-output");
    await run("cp", ["-R", hlsDir, broken]);
    await rm(path.join(broken, "720p", "segment-001.ts"));
    const outDir = path.join(root, "package-broken");
    await expect(packageRelease({ hlsDir: broken, outDir, label: "x" })).rejects.toThrow(/segment-001\.ts is missing/);
    await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a segment that does not decode", async () => {
    const broken = path.join(root, "undecodable-output");
    await run("cp", ["-R", hlsDir, broken]);
    // Still the right size and shape for a transport stream, but not video.
    const size = (await readFile(path.join(broken, "360p", "segment-000.ts"))).length;
    await writeFile(path.join(broken, "360p", "segment-000.ts"), Buffer.alloc(size, 0x47));
    await writeFile(path.join(broken, "360p", "segment-001.ts"), Buffer.alloc(size, 0x47));
    await writeFile(path.join(broken, "360p", "segment-002.ts"), Buffer.alloc(size, 0x47));
    const outDir = path.join(root, "package-undecodable");
    await expect(packageRelease({ hlsDir: broken, outDir, label: "x" })).rejects.toThrow(/FFmpeg could not/);
    await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it("refuses a label that could not be part of a release ID", async () => {
    await expect(packageRelease({ hlsDir, outDir: path.join(root, "package-label"), label: "Release B!" })).rejects.toThrow(/label must be/);
  });
});
