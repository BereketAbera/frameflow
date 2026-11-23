import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { posterStartSeconds, probeVideo, renditionArgs, runProcess, supports1080p } from "../src/services/ffmpeg.js";
import { encodeObjectRendition, publishRenditions, stageObjectPoster } from "../src/services/object-processing.js";
import { FakeObjectStorage } from "../src/storage/fake-storage.js";
import { singleRange } from "../src/api/app.js";

const sourceKey = "videos/v/source/source.mp4", staging = "videos/v/staging/run-1", published = "videos/v/published";

describe("thumbnail, preview and 1080p", () => {
  let root: string, storage: FakeObjectStorage;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "posters-"));
    const source = path.join(root, "source.mp4");
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", source], () => undefined);
    storage = new FakeObjectStorage();
    storage.put(sourceKey, await readFile(source), "video/mp4");
  }, 60_000);
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  const stage = (kind: "thumbnail" | "preview", signal?: AbortSignal) => stageObjectPoster({ storage, sourceKey, stagingPrefix: staging, kind, durationSeconds: 6, scratchRoot: path.join(root, "scratch"), signal, ffmpeg: { logLevel: "error" } });
  const download = async (key: string) => { const file = path.join(root, path.basename(key)); await rm(file, { force: true }); await storage.downloadToFile(key, file); return file; };

  it("starts a quarter of the way in, and never past the end", () => {
    expect(posterStartSeconds(60)).toBe(15);
    expect(posterStartSeconds(0.4)).toBe(0);
    expect(posterStartSeconds(6, 4)).toBe(1.5);
    expect(posterStartSeconds(3, 3)).toBe(0);
  });

  it("only offers 1080p for a source that is already that large", () => {
    expect(supports1080p({ width: 1920, height: 1080 })).toBe(true);
    expect(supports1080p({ width: 3840, height: 2160 })).toBe(true);
    expect(supports1080p({ width: 1280, height: 720 })).toBe(false);
    expect(supports1080p({ width: 1920, height: 800 })).toBe(false);
    expect(renditionArgs({ inputPath: "in.mp4", outputDir: "out", rendition: "1080p", hasAudio: false }).join(" ")).toContain("scale=1920:1080:");
  });

  it("stages a 640x360 JPEG thumbnail", async () => {
    const { object } = await stage("thumbnail");
    expect(object.key).toBe(`${staging}/thumbnail.jpg`);
    expect(object.contentType).toBe("image/jpeg");
    const raw = JSON.parse(await runProcess("ffprobe", ["-v", "error", "-show_streams", "-of", "json", await download(object.key)], () => undefined));
    expect(raw.streams[0]).toMatchObject({ codec_name: "mjpeg", width: 640, height: 360 });
  }, 60_000);

  it("stages a short, silent H.264 preview that starts playing before it has fully downloaded", async () => {
    const { object } = await stage("preview");
    expect(object.key).toBe(`${staging}/preview.mp4`);
    expect(object.contentType).toBe("video/mp4");
    const file = await download(object.key);
    const raw = JSON.parse(await runProcess("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], () => undefined));
    expect(raw.streams).toHaveLength(1);
    expect(raw.streams[0]).toMatchObject({ codec_name: "h264", width: 640, height: 360, pix_fmt: "yuv420p" });
    expect(Number(raw.format.duration)).toBeGreaterThan(3.5);
    expect(Number(raw.format.duration)).toBeLessThan(4.5);
    // +faststart puts the index (moov) ahead of the media (mdat).
    const bytes = await readFile(file);
    expect(bytes.indexOf("moov")).toBeGreaterThan(0);
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
  }, 60_000);

  it("publishes 1080p, the thumbnail and the preview with the other renditions", async () => {
    const metadata = await probeVideo(await download(sourceKey), () => undefined);
    expect(supports1080p(metadata)).toBe(true);
    const encode = (rendition: "360p" | "720p" | "1080p") => encodeObjectRendition({ storage, sourceKey, stagingPrefix: staging, rendition, hasAudio: false, scratchRoot: path.join(root, "scratch"), ffmpeg: { logLevel: "error" } });
    const renditions = await Promise.all([encode("1080p"), encode("360p"), encode("720p")]);
    const posters = [await stage("thumbnail"), await stage("preview")];
    const master = await publishRenditions({ storage, videoId: "v", stagingPrefix: staging, publishedPrefix: published, renditions, posters, scratchRoot: path.join(root, "scratch") });
    const playlist = await readFile(await download(master), "utf8");
    expect(playlist.split("\n").filter((line) => line.endsWith(".m3u8"))).toEqual(["360p/index.m3u8", "720p/index.m3u8", "1080p/index.m3u8"]);
    expect(playlist).toContain("BANDWIDTH=5711200,RESOLUTION=1920x1080");
    const keys = (await storage.listPrefix(published)).map((object) => object.key);
    expect(keys).toEqual(expect.arrayContaining([`${published}/thumbnail.jpg`, `${published}/preview.mp4`, `${published}/1080p/index.m3u8`, `${published}/1080p/segment-000.ts`]));
    expect(await storage.listPrefix(staging)).toEqual([]);
    expect(await readdir(path.join(root, "scratch"))).toEqual([]);
  }, 120_000);

  it("transfers nothing once the task is cancelled", async () => {
    const before = storage.operations.length;
    await expect(stage("preview", AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(storage.operations).toHaveLength(before);
  });

  it("reads one byte range, and refuses what it cannot satisfy", () => {
    expect(singleRange(undefined, 100)).toBeNull();
    expect(singleRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(singleRange("bytes=0-1", 100)).toEqual({ start: 0, end: 1 });
    expect(singleRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(singleRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(singleRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
    expect(singleRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(singleRange("bytes=5-2", 100)).toBe("unsatisfiable");
    expect(singleRange("bytes=-0", 100)).toBe("unsatisfiable");
  });
});
