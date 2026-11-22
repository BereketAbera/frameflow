import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sealPackage } from "../../src/publisher/package.js";
import type { ReleaseManifest } from "../../src/shared/contract.js";

/** A structurally valid MPEG-TS segment: 188-byte packets that each start with the sync byte. The seed makes the bytes distinct. */
export function segmentBytes(packets: number, seed: string): Uint8Array {
  const bytes = new Uint8Array(packets * 188);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 188 === 0 ? 0x47 : (seed.charCodeAt(index % seed.length) + index * 7) & 0xff;
  return bytes;
}

/** The smallest thing the validator accepts as a JPEG: the start and end markers around some bytes. */
export const jpegBytes = (seed: string): Uint8Array => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(`thumbnail of ${seed}`), 0xff, 0xd9]);

/** An MP4 as far as its ftyp box, followed by a body long enough to request ranges of. */
export function mp4Bytes(seed: string): Uint8Array {
  const body = new TextEncoder().encode(`preview of ${seed} `.repeat(64));
  return Uint8Array.from([0, 0, 0, 24, ...new TextEncoder().encode("ftypisom"), 0, 0, 2, 0, ...new TextEncoder().encode("isomiso2"), ...body]);
}

export const MASTER = [
  "#EXTM3U", "#EXT-X-VERSION:3",
  "#EXT-X-STREAM-INF:BANDWIDTH=985600,RESOLUTION=640x360", "360p/index.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=3220800,RESOLUTION=1280x720", "720p/index.m3u8", "",
].join("\n");

export const mediaPlaylist = (segments: number): string => [
  "#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-INDEPENDENT-SEGMENTS",
  ...Array.from({ length: segments }, (_, index) => [`#EXTINF:${index === segments - 1 ? "2.000000" : "4.000000"},`, `segment-${String(index).padStart(3, "0")}.ts`]).flat(),
  "#EXT-X-ENDLIST", "",
].join("\n");

/** Writes the files of a two-rendition release, without a manifest. `seed` decides the media bytes, so two seeds make two different releases. */
export async function writeReleaseFiles(directory: string, seed: string, segments = 3): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "master.m3u8"), MASTER);
  await writeFile(path.join(directory, "thumbnail.jpg"), jpegBytes(seed));
  await writeFile(path.join(directory, "preview.mp4"), mp4Bytes(seed));
  for (const rendition of ["360p", "720p"]) {
    await mkdir(path.join(directory, rendition), { recursive: true });
    await writeFile(path.join(directory, rendition, "index.m3u8"), mediaPlaylist(segments));
    for (let index = 0; index < segments; index++) await writeFile(path.join(directory, rendition, `segment-${String(index).padStart(3, "0")}.ts`), segmentBytes(rendition === "360p" ? 40 : 120, `${seed}/${rendition}/${index}`));
  }
}

export type Workspace = { root: string; package(label: string, seed?: string): Promise<{ directory: string; manifest: ReleaseManifest }>; cleanup(): Promise<void> };

/** A temporary directory for packages, removed after the test. */
export async function workspace(): Promise<Workspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), "frameflow-edge-"));
  let count = 0;
  return {
    root,
    async package(label, seed = label) {
      const directory = path.join(root, `package-${count++}-${label}`);
      await writeReleaseFiles(directory, seed);
      return { directory, manifest: await sealPackage(directory, label) };
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export const sha256Hex = async (bytes: ArrayBuffer | Uint8Array): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (byte) => byte.toString(16).padStart(2, "0")).join("");
