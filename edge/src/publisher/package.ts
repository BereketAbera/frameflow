import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  MANIFEST_NAME, MASTER_PATH, PREVIEW_PATH, THUMBNAIL_PATH, computeReleaseId, isReleaseLabel, serializeReleaseManifest,
  type ReleaseManifest,
} from "../shared/contract.js";
import { PlaylistError, parseMasterPlaylist, parseMediaPlaylist } from "./hls.js";
import { ReleaseValidationError, directorySource, inspectRelease } from "./inspect.js";

const run = promisify(execFile);

export type PackageOptions = {
  /** A completed pipeline output: master.m3u8 beside one directory per rendition. It is only read. */
  hlsDir: string;
  /** Where the package is written. It must not exist yet, or be empty: a package is never edited in place. */
  outDir: string;
  /** The human part of the release ID, such as "a" or "2026w47". */
  label: string;
  /** Where in the video the thumbnail is taken. Defaults to a quarter of the way in. */
  thumbnailAtSeconds?: number;
  /** Length of the muted preview clip that plays on hover. */
  previewSeconds?: number;
  ffmpegPath?: string;
};

async function ffmpeg(binary: string, args: string[], what: string): Promise<void> {
  try { await run(binary, ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], { maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) {
    const failure = error as { code?: string; stderr?: string; message: string };
    if (failure.code === "ENOENT") throw new Error(`${binary} was not found. Packaging needs FFmpeg to make the thumbnail and the preview.`);
    throw new ReleaseValidationError(`FFmpeg could not ${what}: ${(failure.stderr || failure.message).trim().split("\n").slice(-3).join(" ")}`);
  }
}

/**
 * Validates a directory that holds a release's files and writes the manifest that pins them: every path, size and
 * checksum, and the release ID those produce. This is the last step of packaging.
 */
export async function sealPackage(directory: string, label: string): Promise<ReleaseManifest> {
  if (!isReleaseLabel(label)) throw new ReleaseValidationError("The label must be 1 to 16 lowercase letters or digits");
  const inspection = await inspectRelease(directorySource(directory));
  const manifest: ReleaseManifest = {
    schemaVersion: 1, id: await computeReleaseId(label, inspection.files), label, durationSeconds: inspection.durationSeconds,
    master: MASTER_PATH, thumbnail: THUMBNAIL_PATH, preview: PREVIEW_PATH, renditions: inspection.renditions, files: inspection.files,
  };
  await writeFile(path.join(directory, MANIFEST_NAME), serializeReleaseManifest(manifest), { flag: "wx" });
  return manifest;
}

/**
 * Turns a completed HLS output into a release package: the playlists and exactly the segments they reference, a
 * thumbnail, a short muted preview clip, and the manifest that pins all of it by checksum. The release ID comes out
 * of the content, so the same input always yields the same package and a changed input always yields a new ID.
 */
export async function packageRelease(options: PackageOptions): Promise<ReleaseManifest> {
  const { hlsDir, outDir, label, ffmpegPath = "ffmpeg" } = options;
  if (!isReleaseLabel(label)) throw new ReleaseValidationError("The label must be 1 to 16 lowercase letters or digits");
  const existing = await readdir(outDir).catch(() => [] as string[]);
  if (existing.length > 0) throw new ReleaseValidationError(`${outDir} is not empty. A package is never edited in place: choose a new directory.`);
  await mkdir(outDir, { recursive: true });

  try {
    // Copy by reference, starting from the master playlist, so stray files in the source directory never reach a release.
    let master, durationSeconds = 0;
    try {
      master = parseMasterPlaylist(await readFile(path.join(hlsDir, MASTER_PATH), "utf8"));
      await copyFile(path.join(hlsDir, MASTER_PATH), path.join(outDir, MASTER_PATH));
      for (const variant of master.variants) {
        const name = path.posix.dirname(variant.uri), playlist = parseMediaPlaylist(await readFile(path.join(hlsDir, name, "index.m3u8"), "utf8"), variant.uri);
        await mkdir(path.join(outDir, name), { recursive: true });
        for (const file of ["index.m3u8", ...playlist.segments.map((segment) => segment.uri)]) await copyFile(path.join(hlsDir, name, file), path.join(outDir, name, file));
        durationSeconds = Math.max(durationSeconds, playlist.durationSeconds);
      }
    } catch (error) {
      if (error instanceof PlaylistError) throw new ReleaseValidationError(error.message);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ReleaseValidationError(`The HLS output is incomplete: ${path.relative(hlsDir, (error as NodeJS.ErrnoException).path ?? "") || "a referenced file"} is missing`);
      throw error;
    }

    const byHeight = [...master.variants].sort((a, b) => a.height - b.height), smallest = byHeight[0]!, largest = byHeight.at(-1)!;
    // Every rendition must decode from start to end. A playlist that merely lists files is not a playable video.
    for (const variant of master.variants) await ffmpeg(ffmpegPath, ["-i", path.join(outDir, variant.uri), "-map", "0:v:0", "-f", "null", "-"], `decode ${variant.uri}`);

    const thumbnailAt = Math.min(Math.max(options.thumbnailAtSeconds ?? durationSeconds / 4, 0), Math.max(durationSeconds - 0.5, 0));
    await ffmpeg(ffmpegPath, ["-ss", thumbnailAt.toFixed(3), "-i", path.join(outDir, largest.uri), "-map", "0:v:0", "-frames:v", "1", "-q:v", "3", "-map_metadata", "-1", "-f", "image2", "-update", "1", path.join(outDir, THUMBNAIL_PATH)], "extract the thumbnail");
    // The preview plays muted on hover, so it has no audio track, and +faststart lets it begin before it has fully downloaded.
    const previewSeconds = Math.min(Math.max(options.previewSeconds ?? 4, 1), durationSeconds);
    await ffmpeg(ffmpegPath, ["-i", path.join(outDir, smallest.uri), "-t", previewSeconds.toFixed(3), "-map", "0:v:0", "-an", "-c:v", "libx264", "-profile:v", "main", "-preset", "slow", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-f", "mp4", path.join(outDir, PREVIEW_PATH)], "encode the preview");

    return await sealPackage(outDir, label);
  } catch (error) {
    // A half-written package must not be mistaken for a release later.
    await rm(outDir, { recursive: true, force: true });
    throw error;
  }
}
