import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ACTIVE_REFERENCE_KEY, IMMUTABLE_CACHE_CONTROL, JSON_CONTENT_TYPE, MANIFEST_NAME, NO_STORE, RELEASES_PREFIX,
  ContractError, computeReleaseId, isReleaseId, parseActiveReference, parseReleaseManifest, releaseObjectKey, releasePrefix,
  serializeActiveReference, serializeReleaseManifest,
  type ActiveReference, type ReleaseManifest,
} from "../shared/contract.js";
import { ReleaseValidationError, assertMatchesManifest, directorySource, inspectRelease, type ReleaseSource } from "./inspect.js";
import type { ReleaseStore, StoredObject } from "./store.js";

/** Why a release operation stopped. `step` says how far it got, which is what decides what is safe to do next. */
export class ReleaseError extends Error {
  override name = "ReleaseError";
  constructor(readonly step: "package" | "upload" | "verify" | "commit" | "promote", message: string, options?: ErrorOptions) { super(message, options); }
}

export type Log = (message: string) => void;
type Clock = () => Date;

const encoder = new TextEncoder(), decoder = new TextDecoder();

async function mapBounded<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  // Waits for every runner even after one fails, so no upload is still in flight when the caller reports the failure.
  const failure = (await Promise.allSettled(runners)).find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

/** Reads a release back out of the bucket, remembering each object's stored metadata on the way. */
function bucketSource(store: ReleaseStore, releaseId: string): ReleaseSource & { objects: Map<string, StoredObject> } {
  const prefix = releasePrefix(releaseId), objects = new Map<string, StoredObject>();
  return {
    description: "the bucket",
    objects,
    async list() { return (await store.list(prefix)).map((object) => object.key.slice(prefix.length)).filter((file) => file !== MANIFEST_NAME); },
    async read(file) {
      const object = await store.get(releaseObjectKey(releaseId, file));
      if (!object) throw new ReleaseValidationError(`${file} is missing from the bucket`);
      objects.set(file, object);
      return object.body;
    },
  };
}

/** Downloads every object of the release and checks it against the manifest: bytes, playlists, references and stored headers. */
async function verifyBucketCopy(store: ReleaseStore, manifest: ReleaseManifest): Promise<void> {
  const source = bucketSource(store, manifest.id);
  await assertMatchesManifest(await inspectRelease(source), manifest, "the bucket");
  for (const file of manifest.files) {
    const object = source.objects.get(file.path)!;
    if (object.contentType !== file.contentType) throw new ReleaseValidationError(`${file.path} is stored as ${object.contentType ?? "no content type"}, not ${file.contentType}`);
    if (object.cacheControl !== IMMUTABLE_CACHE_CONTROL) throw new ReleaseValidationError(`${file.path} is stored without the immutable Cache-Control`);
    if (object.etag !== `"${file.md5}"`) throw new ReleaseValidationError(`${file.path} is stored with ETag ${object.etag}, not its MD5`);
  }
}

async function readPackage(packageDir: string): Promise<{ manifest: ReleaseManifest; manifestBytes: Uint8Array }> {
  let text: string;
  try { text = await readFile(path.join(packageDir, MANIFEST_NAME), "utf8"); }
  catch { throw new ReleaseError("package", `${packageDir} has no ${MANIFEST_NAME}. Create the package with the "package" command first.`); }
  try {
    const manifest = parseReleaseManifest(text);
    if (serializeReleaseManifest(manifest) !== text) throw new ContractError(`${MANIFEST_NAME} is not in the form the "package" command writes`);
    await assertMatchesManifest(await inspectRelease(directorySource(packageDir)), manifest, "the package");
    return { manifest, manifestBytes: encoder.encode(text) };
  } catch (error) {
    if (error instanceof ContractError || error instanceof ReleaseValidationError) throw new ReleaseError("package", `The package is not a valid release: ${(error as Error).message}`, { cause: error });
    throw error;
  }
}

async function readManifestFromBucket(store: ReleaseStore, releaseId: string): Promise<{ manifest: ReleaseManifest; bytes: Uint8Array } | null> {
  const object = await store.get(releaseObjectKey(releaseId, MANIFEST_NAME));
  if (!object) return null;
  const manifest = parseReleaseManifest(decoder.decode(object.body));
  if (manifest.id !== releaseId || (await computeReleaseId(manifest.label, manifest.files)) !== releaseId) throw new ContractError(`The manifest stored under ${releaseId} describes another release`);
  return { manifest, bytes: object.body };
}

async function readActive(store: ReleaseStore): Promise<{ reference: ActiveReference; etag: string } | null> {
  const object = await store.get(ACTIVE_REFERENCE_KEY);
  return object ? { reference: parseActiveReference(decoder.decode(object.body)), etag: object.etag } : null;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index]);

export type PublishResult = { releaseId: string; uploaded: number; alreadyPresent: number; alreadyComplete: boolean; promotion?: PromoteResult };

/**
 * Publishes a packaged release under its own immutable prefix:
 *
 *   1. validate the package against its manifest, before anything is written;
 *   2. create each object, never replacing one that exists;
 *   3. read the whole release back from the bucket and validate that copy the same way;
 *   4. only then create the manifest, which is what makes the release exist for the Worker;
 *   5. optionally move the active reference.
 *
 * A failure at any step leaves the active reference exactly as it was.
 */
export async function publishRelease(options: { store: ReleaseStore; packageDir: string; promote?: boolean; expectActive?: string | null; concurrency?: number; log?: Log; now?: Clock }): Promise<PublishResult> {
  const { store, packageDir, log = () => {} } = options;
  const { manifest, manifestBytes } = await readPackage(packageDir);
  const manifestKey = releaseObjectKey(manifest.id, MANIFEST_NAME);
  log(`Package ${manifest.id} is valid: ${manifest.files.length} files, ${manifest.renditions.map((r) => r.name).join(" + ")}, ${manifest.durationSeconds} s.`);

  const committed = await store.get(manifestKey);
  if (committed && !sameBytes(committed.body, manifestBytes)) throw new ReleaseError("upload", `A different manifest is already stored for ${manifest.id}. Nothing was written.`);
  let uploaded = 0, alreadyPresent = 0;
  if (!committed) {
    try {
      await mapBounded(manifest.files, options.concurrency ?? 4, async (file) => {
        const body = await readFile(path.join(packageDir, ...file.path.split("/")));
        const result = await store.createOnly({ key: releaseObjectKey(manifest.id, file.path), body, contentType: file.contentType, cacheControl: IMMUTABLE_CACHE_CONTROL });
        if (result.created) uploaded++; else alreadyPresent++;
      });
    } catch (error) {
      throw new ReleaseError("upload", `Upload of ${manifest.id} stopped: ${(error as Error).message}. The release has no manifest, so it is not served, and the active release is unchanged. Run publish again to resume.`, { cause: error });
    }
    log(`Uploaded ${uploaded} objects${alreadyPresent ? `, found ${alreadyPresent} already in the bucket` : ""}.`);
  } else log(`${manifest.id} is already complete in the bucket.`);

  try { await verifyBucketCopy(store, manifest); }
  catch (error) {
    if (!(error instanceof ReleaseValidationError)) throw new ReleaseError("verify", `Could not read ${manifest.id} back from the bucket: ${(error as Error).message}. The active release is unchanged.`, { cause: error });
    throw new ReleaseError("verify", `The bucket copy of ${manifest.id} is not the packaged release: ${(error as Error).message}. ${committed ? "This release must not be promoted." : "No manifest was written, so it is not served."} The active release is unchanged.`, { cause: error });
  }
  log("Verified the bucket copy: every playlist, segment, thumbnail and preview matches the manifest.");

  if (!committed) {
    const created = await store.createOnly({ key: manifestKey, body: manifestBytes, contentType: JSON_CONTENT_TYPE, cacheControl: IMMUTABLE_CACHE_CONTROL });
    if (!created.created) {
      const other = await store.get(manifestKey);
      if (!other || !sameBytes(other.body, manifestBytes)) throw new ReleaseError("commit", `Another publisher wrote a different manifest for ${manifest.id}. The active release is unchanged.`);
    }
    log(`Committed ${manifest.id}: its version URLs are now served.`);
  }

  const result: PublishResult = { releaseId: manifest.id, uploaded, alreadyPresent, alreadyComplete: Boolean(committed) };
  if (options.promote) result.promotion = await promoteRelease({ store, releaseId: manifest.id, expectActive: options.expectActive, log, now: options.now });
  return result;
}

export type PromoteResult = { changed: boolean; activeRelease: string; previousRelease: string | null; sequence: number };

/**
 * Points the active reference at a complete release. The write is conditional on the reference still being the one
 * that was read (or still being absent), so two operators can never silently overwrite each other.
 * `expectActive` also refuses to proceed unless that release (or, for null, no release) is active right now.
 */
export async function promoteRelease(options: { store: ReleaseStore; releaseId: string; expectActive?: string | null; log?: Log; now?: Clock }): Promise<PromoteResult> {
  const { store, releaseId, log = () => {}, now = () => new Date() } = options;
  if (!isReleaseId(releaseId)) throw new ReleaseError("promote", `${JSON.stringify(releaseId)} is not a release ID`);

  let stored: Awaited<ReturnType<typeof readManifestFromBucket>>;
  try { stored = await readManifestFromBucket(store, releaseId); }
  catch (error) { if (error instanceof ContractError) throw new ReleaseError("promote", `${releaseId} has an invalid manifest: ${error.message}. The active release is unchanged.`, { cause: error }); throw error; }
  if (!stored) throw new ReleaseError("promote", `${releaseId} is not a complete release in the bucket (it has no manifest). The active release is unchanged.`);
  const present = new Map((await store.list(releasePrefix(releaseId))).map((object) => [object.key, object]));
  for (const file of stored.manifest.files) {
    const object = present.get(releaseObjectKey(releaseId, file.path));
    if (!object || object.size !== file.size || object.etag !== `"${file.md5}"`) throw new ReleaseError("promote", `${releaseId} is damaged in the bucket: ${file.path} is ${object ? "not the published object" : "missing"}. The active release is unchanged.`);
  }

  const current = await readActive(store);
  const activeNow = current?.reference.activeRelease ?? null;
  if (options.expectActive !== undefined && options.expectActive !== activeNow) throw new ReleaseError("promote", `Expected ${options.expectActive ?? "no release"} to be active, but ${activeNow ?? "no release"} is. Nothing was written.`);
  if (current && activeNow === releaseId) {
    log(`${releaseId} is already active.`);
    return { changed: false, activeRelease: releaseId, previousRelease: current.reference.previousRelease, sequence: current.reference.sequence };
  }
  const next: ActiveReference = { schemaVersion: 1, activeRelease: releaseId, previousRelease: activeNow, sequence: (current?.reference.sequence ?? 0) + 1, updatedAt: now().toISOString() };
  const put = { key: ACTIVE_REFERENCE_KEY, body: encoder.encode(serializeActiveReference(next)), contentType: JSON_CONTENT_TYPE, cacheControl: NO_STORE };
  const written = current ? (await store.replaceIfMatch({ ...put, ifMatch: current.etag })).replaced : (await store.createOnly(put)).created;
  if (!written) {
    // The condition can fail although the reference now says what this promotion wanted: the write landed and only
    // its answer was lost, so the retry found the condition spent, or another operator promoted the same release at
    // the same moment. Neither is a conflict. Anything else is, and nothing was overwritten.
    const after = await readActive(store);
    if (after?.reference.activeRelease !== releaseId) throw new ReleaseError("promote", "The active reference changed while promoting. Nothing was overwritten: check the status and run the command again.");
    const ours = sameBytes(encoder.encode(serializeActiveReference(after.reference)), put.body);
    log(ours ? `Active release: ${releaseId} (was ${activeNow ?? "none"}).` : `${releaseId} was made active by another promotion at the same time.`);
    return { changed: ours, activeRelease: releaseId, previousRelease: after.reference.previousRelease, sequence: after.reference.sequence };
  }
  log(`Active release: ${releaseId} (was ${activeNow ?? "none"}).`);
  return { changed: true, activeRelease: releaseId, previousRelease: activeNow, sequence: next.sequence };
}

/** Returns to the release that was active before the current one, or to `to`. It is a promotion, so it needs no purge and no upload. */
export async function rollbackRelease(options: { store: ReleaseStore; to?: string; log?: Log; now?: Clock }): Promise<PromoteResult> {
  const current = await readActive(options.store);
  if (!current) throw new ReleaseError("promote", "No release is active, so there is nothing to roll back.");
  const target = options.to ?? current.reference.previousRelease;
  if (!target) throw new ReleaseError("promote", `${current.reference.activeRelease} has no previous release recorded. Name one with --to.`);
  return promoteRelease({ store: options.store, releaseId: target, expectActive: current.reference.activeRelease, log: options.log, now: options.now });
}

export type ReleaseSummary = { releaseId: string; complete: boolean; objects: number; bytes: number };
export type Status = { active: ActiveReference | null; releases: ReleaseSummary[] };

/** The active reference and every release prefix in the bucket. A release counts as complete only with a manifest that is really its own. */
export async function readStatus(store: ReleaseStore): Promise<Status> {
  const releases = new Map<string, ReleaseSummary>(), withManifest: string[] = [];
  for (const object of await store.list(RELEASES_PREFIX)) {
    const [releaseId = "", ...rest] = object.key.slice(RELEASES_PREFIX.length).split("/");
    const summary = releases.get(releaseId) ?? { releaseId, complete: false, objects: 0, bytes: 0 };
    if (rest.join("/") === MANIFEST_NAME) withManifest.push(releaseId); else { summary.objects++; summary.bytes += object.size; }
    releases.set(releaseId, summary);
  }
  for (const releaseId of withManifest) {
    const stored = isReleaseId(releaseId) ? await readManifestFromBucket(store, releaseId).catch((error: unknown) => { if (error instanceof ContractError) return null; throw error; }) : null;
    releases.get(releaseId)!.complete = stored !== null;
  }
  return { active: (await readActive(store))?.reference ?? null, releases: [...releases.values()].sort((a, b) => a.releaseId.localeCompare(b.releaseId)) };
}

/** Re-validates a complete release in place, for audits and before a rollback to something old. */
export async function verifyRelease(store: ReleaseStore, releaseId: string): Promise<ReleaseManifest> {
  if (!isReleaseId(releaseId)) throw new ReleaseError("verify", `${JSON.stringify(releaseId)} is not a release ID`);
  const stored = await readManifestFromBucket(store, releaseId);
  if (!stored) throw new ReleaseError("verify", `${releaseId} is not a complete release in the bucket`);
  try { await verifyBucketCopy(store, stored.manifest); }
  catch (error) { throw new ReleaseError("verify", `${releaseId} failed verification: ${(error as Error).message}`, { cause: error }); }
  return stored.manifest;
}
