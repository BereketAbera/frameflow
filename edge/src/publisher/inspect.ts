import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  MANIFEST_NAME, MASTER_PATH, MAX_FILE_BYTES, MAX_RELEASE_FILES, PREVIEW_PATH, THUMBNAIL_PATH,
  classifyReleaseFile, computeReleaseId,
  type ReleaseFile, type ReleaseManifest, type ReleaseRendition,
} from "../shared/contract.js";
import { PlaylistError, parseMasterPlaylist, parseMediaPlaylist } from "./hls.js";

/** A problem with the release itself, as opposed to a failed network call. The message names the file. */
export class ReleaseValidationError extends Error {
  override name = "ReleaseValidationError";
}

/** Where a release is read from: a package directory before upload, the bucket after it. The manifest is never part of the listing. */
export interface ReleaseSource {
  /** What this source is, for error messages: "the package" or "the bucket". */
  readonly description: string;
  list(): Promise<string[]>;
  read(path: string): Promise<Uint8Array>;
}

export type Inspection = { files: ReleaseFile[]; renditions: ReleaseRendition[]; durationSeconds: number };

/** Rendition durations differ by a frame or an audio packet. More than this means the renditions are not the same video. */
const DURATION_TOLERANCE_SECONDS = 0.5;
const TS_PACKET = 188, TS_SYNC = 0x47;

/** A playlist that does not parse is a problem with the release, like any other. */
function readPlaylist<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) { throw error instanceof PlaylistError ? new ReleaseValidationError(error.message) : error; }
}

function decodeText(bytes: Uint8Array, name: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ReleaseValidationError(`${name} is not UTF-8 text`); }
}

function checkMedia(kind: "segment" | "thumbnail" | "preview", name: string, bytes: Uint8Array): void {
  if (kind === "segment") {
    if (bytes.length % TS_PACKET !== 0 || bytes[0] !== TS_SYNC || (bytes.length > TS_PACKET && bytes[TS_PACKET] !== TS_SYNC)) throw new ReleaseValidationError(`${name} is not an MPEG-TS segment`);
  } else if (kind === "thumbnail") {
    const end = bytes.length;
    if (end < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes[end - 2] !== 0xff || bytes[end - 1] !== 0xd9) throw new ReleaseValidationError(`${name} is not a complete JPEG image`);
  } else if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") {
    throw new ReleaseValidationError(`${name} is not an MP4 file`);
  }
}

/**
 * Reads a whole release and checks that it hangs together: the master parses, every variant playlist it names
 * parses, every segment a playlist names is present and looks like its type, and nothing is present that no
 * playlist references. The result describes exactly the bytes that were read.
 */
export async function inspectRelease(source: ReleaseSource): Promise<Inspection> {
  const where = source.description, listed = [...new Set(await source.list())].sort();
  if (listed.length > MAX_RELEASE_FILES) throw new ReleaseValidationError(`${where} holds more than ${MAX_RELEASE_FILES} files`);
  const stray = listed.find((file) => !classifyReleaseFile(file));
  if (stray) throw new ReleaseValidationError(`${where} holds ${stray}, which is not a file a release may contain`);
  const present = new Set(listed);
  for (const required of [MASTER_PATH, THUMBNAIL_PATH, PREVIEW_PATH]) if (!present.has(required)) throw new ReleaseValidationError(`${where} has no ${required}`);

  const contents = new Map<string, Uint8Array>();
  const read = async (file: string): Promise<Uint8Array> => {
    let bytes = contents.get(file);
    if (!bytes) {
      bytes = await source.read(file);
      if (bytes.length === 0) throw new ReleaseValidationError(`${file} is empty in ${where}`);
      if (bytes.length > MAX_FILE_BYTES) throw new ReleaseValidationError(`${file} is larger than ${MAX_FILE_BYTES} bytes`);
      contents.set(file, bytes);
    }
    return bytes;
  };

  const masterText = decodeText(await read(MASTER_PATH), MASTER_PATH), master = readPlaylist(() => parseMasterPlaylist(masterText, MASTER_PATH));
  const referenced = new Set<string>([MASTER_PATH, THUMBNAIL_PATH, PREVIEW_PATH]), renditions: ReleaseRendition[] = [], durations: number[] = [];
  for (const variant of master.variants) {
    if (!present.has(variant.uri)) throw new ReleaseValidationError(`${MASTER_PATH} references ${variant.uri}, which is missing from ${where}`);
    referenced.add(variant.uri);
    const name = variant.uri.slice(0, variant.uri.indexOf("/")), playlistText = decodeText(await read(variant.uri), variant.uri);
    const playlist = readPlaylist(() => parseMediaPlaylist(playlistText, variant.uri));
    for (const segment of playlist.segments) {
      const file = `${name}/${segment.uri}`;
      if (!present.has(file)) throw new ReleaseValidationError(`${variant.uri} references ${file}, which is missing from ${where}`);
      referenced.add(file);
    }
    durations.push(playlist.durationSeconds);
    renditions.push({ name, playlist: variant.uri, width: variant.width, height: variant.height, bandwidth: variant.bandwidth, segments: playlist.segments.length });
  }
  const unreferenced = listed.find((file) => !referenced.has(file));
  if (unreferenced) throw new ReleaseValidationError(`${where} holds ${unreferenced}, which no playlist references`);
  const longest = Math.max(...durations), shortest = Math.min(...durations);
  if (longest - shortest > DURATION_TOLERANCE_SECONDS) throw new ReleaseValidationError(`The renditions in ${where} differ in duration by ${(longest - shortest).toFixed(3)} s`);

  const files: ReleaseFile[] = [];
  for (const file of listed) {
    const bytes = await read(file), kind = classifyReleaseFile(file)!;
    if (kind.kind === "segment" || kind.kind === "thumbnail" || kind.kind === "preview") checkMedia(kind.kind, file, bytes);
    files.push({ path: file, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), md5: createHash("md5").update(bytes).digest("hex"), contentType: kind.contentType });
  }
  return { files, renditions, durationSeconds: Math.round(longest * 1000) / 1000 };
}

/** Fails unless what was read is, byte for byte and file for file, what the manifest describes. */
export async function assertMatchesManifest(inspection: Inspection, manifest: ReleaseManifest, where: string): Promise<void> {
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  for (const file of inspection.files) {
    const listed = expected.get(file.path);
    if (!listed) throw new ReleaseValidationError(`${where} holds ${file.path}, which the manifest does not list`);
    if (listed.size !== file.size || listed.sha256 !== file.sha256 || listed.md5 !== file.md5) throw new ReleaseValidationError(`${file.path} in ${where} differs from the manifest (${file.size} bytes, sha256 ${file.sha256.slice(0, 12)}…; the manifest lists ${listed.size} bytes, sha256 ${listed.sha256.slice(0, 12)}…)`);
    expected.delete(file.path);
  }
  const missing = expected.keys().next();
  if (!missing.done) throw new ReleaseValidationError(`${missing.value} is listed in the manifest but missing from ${where}`);
  if (JSON.stringify(inspection.renditions) !== JSON.stringify(manifest.renditions) || inspection.durationSeconds !== manifest.durationSeconds) throw new ReleaseValidationError(`The playlists in ${where} do not describe the renditions the manifest lists`);
  if ((await computeReleaseId(manifest.label, inspection.files)) !== manifest.id) throw new ReleaseValidationError(`The content in ${where} does not produce the release ID ${manifest.id}`);
}

/** A package directory: every regular file under it, as POSIX paths, without the manifest. */
export function directorySource(root: string): ReleaseSource {
  return {
    description: "the package",
    async list() {
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")).filter((file) => file !== MANIFEST_NAME);
    },
    async read(file) {
      // inspectRelease only reads paths it classified, so a file can never name something outside the root.
      if (!classifyReleaseFile(file)) throw new ReleaseValidationError(`${file} is not a file a release may contain`);
      return readFile(path.join(root, ...file.split("/")));
    },
  };
}
