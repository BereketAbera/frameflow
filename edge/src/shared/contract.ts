/**
 * The contract between the release publisher and the Worker: where public objects live, which files a release may
 * hold, and the two JSON documents that describe one. Both sides import this file, so neither can drift from the other.
 * It uses only APIs that Node and the Workers runtime share.
 */

/** Everything public lives under this one prefix, in the URL space and in the bucket alike. */
export const PUBLIC_PREFIX = "public-demo";
/** The only mutable object: which release is active. Written with conditional writes and never cached. */
export const ACTIVE_REFERENCE_KEY = `${PUBLIC_PREFIX}/active.json`;
export const RELEASES_PREFIX = `${PUBLIC_PREFIX}/releases/`;
/** Written last, once every other object of the release is verified in the bucket. Without it the Worker serves nothing of that release. */
export const MANIFEST_NAME = "release.json";

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const NO_STORE = "no-store";
export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/** The publisher holds each file in memory to hash it, and the Worker tees each body into the edge cache. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_RELEASE_FILES = 2000;
export const MAX_MANIFEST_BYTES = 1024 * 1024;

export class ContractError extends Error {
  override name = "ContractError";
}

const RELEASE_LABEL = /^[a-z0-9]{1,16}$/;
const RELEASE_ID = /^[a-z0-9]{1,16}-[0-9a-f]{16}$/;
const RENDITION_NAME = /^[0-9]{3,4}p$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MD5_HEX = /^[0-9a-f]{32}$/;

export const isReleaseLabel = (value: string): boolean => RELEASE_LABEL.test(value);
export const isReleaseId = (value: string): boolean => RELEASE_ID.test(value);

export type ReleaseFileKind = "master" | "playlist" | "segment" | "thumbnail" | "preview";

/**
 * The complete list of what a release can contain. A path that matches none of these is never uploaded by the
 * publisher and never served by the Worker, whatever is in the bucket. The content type comes from this table, not
 * from stored metadata.
 */
const FILE_RULES: ReadonlyArray<{ kind: ReleaseFileKind; pattern: RegExp; contentType: string }> = [
  { kind: "master", pattern: /^master\.m3u8$/, contentType: "application/vnd.apple.mpegurl" },
  { kind: "playlist", pattern: /^[0-9]{3,4}p\/index\.m3u8$/, contentType: "application/vnd.apple.mpegurl" },
  { kind: "segment", pattern: /^[0-9]{3,4}p\/segment-[0-9]{3,6}\.ts$/, contentType: "video/mp2t" },
  { kind: "thumbnail", pattern: /^thumbnail\.jpg$/, contentType: "image/jpeg" },
  { kind: "preview", pattern: /^preview\.mp4$/, contentType: "video/mp4" },
];

export const MASTER_PATH = "master.m3u8";
export const THUMBNAIL_PATH = "thumbnail.jpg";
export const PREVIEW_PATH = "preview.mp4";

export function classifyReleaseFile(path: string): { kind: ReleaseFileKind; contentType: string } | null {
  for (const rule of FILE_RULES) if (rule.pattern.test(path)) return { kind: rule.kind, contentType: rule.contentType };
  return null;
}

export const releasePrefix = (releaseId: string): string => `${RELEASES_PREFIX}${releaseId}/`;
export const releaseObjectKey = (releaseId: string, path: string): string => `${releasePrefix(releaseId)}${path}`;
/** URL paths mirror object keys one to one, so there is no mapping to get wrong. */
export const releaseUrlPath = (releaseId: string, path: string): string => `/${releaseObjectKey(releaseId, path)}`;

export type ReleaseFile = {
  path: string;
  size: number;
  /** Identifies the content: the release ID derives from it, the publisher verifies the bucket copy with it, and it is the ETag. */
  sha256: string;
  /** What the bucket computes for an object. The Worker compares it on every read from the bucket. */
  md5: string;
  contentType: string;
};

export type ReleaseRendition = { name: string; playlist: string; width: number; height: number; bandwidth: number; segments: number };

export type ReleaseManifest = {
  schemaVersion: 1;
  id: string;
  label: string;
  durationSeconds: number;
  master: string;
  thumbnail: string;
  preview: string;
  renditions: ReleaseRendition[];
  /** Sorted by path. The manifest itself is not listed. */
  files: ReleaseFile[];
};

export type ActiveReference = {
  schemaVersion: 1;
  activeRelease: string;
  /** What rollback returns to by default. */
  previousRelease: string | null;
  /** Counts every change of the active release, so two readers can tell which state is newer. */
  sequence: number;
  updatedAt: string;
};

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let hex = "";
  for (const byte of view) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * A release ID is its label plus a digest of every file's path, size and SHA-256. Different content can therefore
 * never claim an existing version path, and publishing the same content again resolves to the same path.
 */
export async function computeReleaseId(label: string, files: ReadonlyArray<Pick<ReleaseFile, "path" | "size" | "sha256">>): Promise<string> {
  if (!isReleaseLabel(label)) throw new ContractError("A release label is 1 to 16 lowercase letters or digits");
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((file) => `${file.path}\t${file.size}\t${file.sha256}\n`);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`frameflow-release-v1\n${lines.join("")}`));
  return `${label}-${toHex(digest).slice(0, 16)}`;
}

type JsonObject = Record<string, unknown>;

function parseObject(input: string, what: string): JsonObject {
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new ContractError(`${what} is not valid JSON`); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ContractError(`${what} must be a JSON object`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[], what: string): void {
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.includes(key)), missing = keys.filter((key) => !actual.includes(key));
  if (unknown.length > 0) throw new ContractError(`${what} has unknown field ${unknown[0]}`);
  if (missing.length > 0) throw new ContractError(`${what} is missing field ${missing[0]}`);
}

function positiveInteger(value: unknown, what: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max) throw new ContractError(`${what} must be a positive integer${max < Number.MAX_SAFE_INTEGER ? ` of at most ${max}` : ""}`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new ContractError(`${what} must be a string`);
  return value;
}

const MANIFEST_KEYS = ["schemaVersion", "id", "label", "durationSeconds", "master", "thumbnail", "preview", "renditions", "files"] as const;
const FILE_KEYS = ["path", "size", "sha256", "md5", "contentType"] as const;
const RENDITION_KEYS = ["name", "playlist", "width", "height", "bandwidth", "segments"] as const;
const ACTIVE_KEYS = ["schemaVersion", "activeRelease", "previousRelease", "sequence", "updatedAt"] as const;

/** Throws a ContractError unless the text is a complete, self-consistent manifest. It does not recompute the release ID: see computeReleaseId. */
export function parseReleaseManifest(input: string): ReleaseManifest {
  const value = parseObject(input, "The release manifest");
  exactKeys(value, MANIFEST_KEYS, "The release manifest");
  if (value.schemaVersion !== 1) throw new ContractError("The release manifest has an unsupported schemaVersion");
  const id = text(value.id, "id"), label = text(value.label, "label");
  if (!isReleaseId(id) || !isReleaseLabel(label) || !id.startsWith(`${label}-`)) throw new ContractError("The release manifest has an invalid id or label");
  const durationSeconds = value.durationSeconds;
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new ContractError("durationSeconds must be a positive number");
  if (value.master !== MASTER_PATH || value.thumbnail !== THUMBNAIL_PATH || value.preview !== PREVIEW_PATH) throw new ContractError("The release manifest names an unexpected master, thumbnail or preview");

  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_RELEASE_FILES) throw new ContractError(`files must list 1 to ${MAX_RELEASE_FILES} entries`);
  const files: ReleaseFile[] = value.files.map((entry: unknown, index: number) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new ContractError(`files[${index}] must be an object`);
    const file = entry as JsonObject;
    exactKeys(file, FILE_KEYS, `files[${index}]`);
    const path = text(file.path, `files[${index}].path`), kind = classifyReleaseFile(path);
    if (!kind) throw new ContractError(`files[${index}].path is not a file a release may hold: ${path}`);
    if (file.contentType !== kind.contentType) throw new ContractError(`${path} must have content type ${kind.contentType}`);
    const sha256 = text(file.sha256, `${path} sha256`), md5 = text(file.md5, `${path} md5`);
    if (!SHA256_HEX.test(sha256) || !MD5_HEX.test(md5)) throw new ContractError(`${path} has a malformed checksum`);
    return { path, size: positiveInteger(file.size, `${path} size`, MAX_FILE_BYTES), sha256, md5, contentType: kind.contentType };
  });
  for (let index = 1; index < files.length; index++) {
    if (files[index - 1]!.path >= files[index]!.path) throw new ContractError("files must be sorted by path without duplicates");
  }
  const paths = new Set(files.map((file) => file.path));
  for (const required of [MASTER_PATH, THUMBNAIL_PATH, PREVIEW_PATH]) if (!paths.has(required)) throw new ContractError(`The release has no ${required}`);

  if (!Array.isArray(value.renditions) || value.renditions.length === 0) throw new ContractError("renditions must list at least one rendition");
  const names = new Set<string>();
  const renditions: ReleaseRendition[] = value.renditions.map((entry: unknown, index: number) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new ContractError(`renditions[${index}] must be an object`);
    const rendition = entry as JsonObject;
    exactKeys(rendition, RENDITION_KEYS, `renditions[${index}]`);
    const name = text(rendition.name, `renditions[${index}].name`);
    if (!RENDITION_NAME.test(name) || names.has(name)) throw new ContractError(`renditions[${index}].name is invalid or repeated`);
    names.add(name);
    if (rendition.playlist !== `${name}/index.m3u8` || !paths.has(`${name}/index.m3u8`)) throw new ContractError(`Rendition ${name} has no playlist in files`);
    const segments = positiveInteger(rendition.segments, `${name} segments`);
    if (files.filter((file) => file.path.startsWith(`${name}/segment-`)).length !== segments) throw new ContractError(`Rendition ${name} does not list exactly its ${segments} segments`);
    return { name, playlist: `${name}/index.m3u8`, width: positiveInteger(rendition.width, `${name} width`), height: positiveInteger(rendition.height, `${name} height`), bandwidth: positiveInteger(rendition.bandwidth, `${name} bandwidth`), segments };
  });
  for (const file of files) {
    const slash = file.path.indexOf("/");
    if (slash !== -1 && !names.has(file.path.slice(0, slash))) throw new ContractError(`${file.path} belongs to no listed rendition`);
  }
  return { schemaVersion: 1, id, label, durationSeconds, master: MASTER_PATH, thumbnail: THUMBNAIL_PATH, preview: PREVIEW_PATH, renditions, files };
}

/** The one canonical byte form of a manifest: fixed field order, two-space indentation, a final newline. */
export function serializeReleaseManifest(manifest: ReleaseManifest): string {
  const ordered = {
    schemaVersion: manifest.schemaVersion, id: manifest.id, label: manifest.label, durationSeconds: manifest.durationSeconds,
    master: manifest.master, thumbnail: manifest.thumbnail, preview: manifest.preview,
    renditions: manifest.renditions.map((r) => ({ name: r.name, playlist: r.playlist, width: r.width, height: r.height, bandwidth: r.bandwidth, segments: r.segments })),
    files: manifest.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, md5: f.md5, contentType: f.contentType })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function parseActiveReference(input: string): ActiveReference {
  const value = parseObject(input, "The active reference");
  exactKeys(value, ACTIVE_KEYS, "The active reference");
  if (value.schemaVersion !== 1) throw new ContractError("The active reference has an unsupported schemaVersion");
  const activeRelease = text(value.activeRelease, "activeRelease");
  if (!isReleaseId(activeRelease)) throw new ContractError("activeRelease is not a release ID");
  const previousRelease = value.previousRelease;
  if (previousRelease !== null && (typeof previousRelease !== "string" || !isReleaseId(previousRelease))) throw new ContractError("previousRelease must be a release ID or null");
  const updatedAt = text(value.updatedAt, "updatedAt");
  if (Number.isNaN(Date.parse(updatedAt))) throw new ContractError("updatedAt is not a timestamp");
  return { schemaVersion: 1, activeRelease, previousRelease, sequence: positiveInteger(value.sequence, "sequence"), updatedAt };
}

export function serializeActiveReference(reference: ActiveReference): string {
  const ordered = { schemaVersion: reference.schemaVersion, activeRelease: reference.activeRelease, previousRelease: reference.previousRelease, sequence: reference.sequence, updatedAt: reference.updatedAt };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
