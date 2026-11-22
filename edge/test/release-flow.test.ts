/**
 * The release story end to end, in the order an operator would live it: publish A, fail to publish B in three
 * different ways, publish B, promote it, roll back. The publisher writes over the S3 API and the Worker reads through
 * its R2 binding, as in staging. Everything here is local: it proves the logic, not Cloudflare's edge.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealPackage } from "../src/publisher/package.js";
import { ReleaseValidationError } from "../src/publisher/inspect.js";
import { ReleaseError, promoteRelease, publishRelease, readStatus, rollbackRelease, verifyRelease } from "../src/publisher/releases.js";
import type { ReleaseStore } from "../src/publisher/store.js";
import { ACTIVE_REFERENCE_KEY, MANIFEST_NAME, releaseObjectKey, releaseUrlPath, type ReleaseManifest } from "../src/shared/contract.js";
import { startLocalEdge, type LocalEdge } from "../local/runtime.js";
import { MASTER, jpegBytes, sha256Hex, workspace, writeReleaseFiles, type Workspace } from "./support/fixtures.js";

let edge: LocalEdge, files: Workspace;
let a: { directory: string; manifest: ReleaseManifest }, b: typeof a;
beforeAll(async () => { edge = await startLocalEdge(); files = await workspace(); });
afterAll(async () => { await edge.dispose(); await files.cleanup(); });

const current = async () => { const response = await edge.fetch("/public-demo/current.json"); return { status: response.status, body: (await response.json()) as Record<string, any> }; };
const activeEtag = async () => (await edge.store.head(ACTIVE_REFERENCE_KEY))?.etag;

/** Every file of the release is served complete and correct, and can be read from the middle: what a player needs to play and to seek. */
async function expectPlayableAndSeekable(manifest: ReleaseManifest): Promise<void> {
  for (const file of manifest.files) {
    const url = releaseUrlPath(manifest.id, file.path), whole = await edge.fetch(url);
    expect(whole.status, url).toBe(200);
    expect(whole.headers.get("content-type")).toBe(file.contentType);
    const bytes = new Uint8Array(await whole.arrayBuffer());
    expect(await sha256Hex(bytes), url).toBe(file.sha256);
    const start = Math.floor(file.size / 2), part = await edge.fetch(url, { headers: { range: `bytes=${start}-` } });
    expect(part.status, `${url} from byte ${start}`).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes ${start}-${file.size - 1}/${file.size}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(start));
  }
}

/** The store with one of its operations replaced, to put a failure or another operator at an exact point of a publish. */
function withOperation<K extends keyof ReleaseStore>(store: ReleaseStore, name: K, replacement: (original: ReleaseStore[K]) => ReleaseStore[K]): ReleaseStore {
  return new Proxy(store, { get(target, property, receiver) {
    const value: unknown = Reflect.get(target, property, receiver);
    if (property === name) return replacement((value as (...parameters: never[]) => unknown).bind(target) as ReleaseStore[K]);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

/** A store that stops working after a number of uploads, like a publisher that loses its connection or is interrupted. */
function failingAfter(store: ReleaseStore, uploads: number): ReleaseStore {
  let done = 0;
  return withOperation(store, "createOnly", (createOnly) => async (input) => { if (done++ >= uploads) throw new Error("connection lost"); return createOnly(input); });
}

describe("release A", () => {
  it("is refused while there is nothing to serve", async () => {
    expect((await current()).status).toBe(404);
    expect((await edge.fetch("/public-demo/current.m3u8")).status).toBe(404);
  });

  it("is published under its own version path and made active", async () => {
    a = await files.package("a");
    const result = await publishRelease({ store: edge.store, packageDir: a.directory, promote: true, expectActive: null });
    expect(result).toMatchObject({ releaseId: a.manifest.id, uploaded: a.manifest.files.length, alreadyPresent: 0, alreadyComplete: false, promotion: { changed: true, activeRelease: a.manifest.id, previousRelease: null, sequence: 1 } });

    const { status, body } = await current();
    expect(status).toBe(200);
    expect(body).toMatchObject({ release: a.manifest.id, sequence: 1, playlist: `/public-demo/releases/${a.manifest.id}/master.m3u8`, thumbnail: `/public-demo/releases/${a.manifest.id}/thumbnail.jpg`, preview: `/public-demo/releases/${a.manifest.id}/preview.mp4` });
    const playlist = await edge.fetch(body.playlist);
    expect(await playlist.text()).toBe(MASTER);
    const redirect = await edge.fetch("/public-demo/current.m3u8");
    expect([redirect.status, redirect.headers.get("location")]).toEqual([302, body.playlist]);
  });

  it("plays and seeks", async () => { await expectPlayableAndSeekable(a.manifest); });
});

describe("a broken publish of release B leaves A active and seekable", () => {
  const expectAStillActive = async (etagBefore: string | undefined) => {
    expect(await activeEtag()).toBe(etagBefore);
    expect((await current()).body).toMatchObject({ release: a.manifest.id, sequence: 1 });
    await expectPlayableAndSeekable(a.manifest);
  };

  it("when a playlist references a segment that is not there: nothing is uploaded", async () => {
    const etag = await activeEtag(), directory = path.join(files.root, "b-missing-segment");
    await writeReleaseFiles(directory, "b");
    await rm(path.join(directory, "720p", "segment-001.ts"));
    // It cannot even be packaged…
    await expect(sealPackage(directory, "b")).rejects.toThrow(/720p\/index\.m3u8 references 720p\/segment-001\.ts, which is missing/);
    // …and a package damaged after it was sealed is refused by publish before any write.
    const sealed = await files.package("b");
    await rm(path.join(sealed.directory, "720p", "segment-001.ts"));
    const failure = await publishRelease({ store: edge.store, packageDir: sealed.directory, promote: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReleaseError);
    expect(failure).toMatchObject({ step: "package", message: expect.stringMatching(/segment-001\.ts/) });
    expect(await edge.store.list(`public-demo/releases/${sealed.manifest.id}/`)).toEqual([]);
    await expectAStillActive(etag);
  });

  it("when a file changed after packaging: nothing is uploaded", async () => {
    const etag = await activeEtag(), sealed = await files.package("b");
    await writeFile(path.join(sealed.directory, "thumbnail.jpg"), jpegBytes("something else"));
    await expect(publishRelease({ store: edge.store, packageDir: sealed.directory, promote: true })).rejects.toMatchObject({ step: "package", message: expect.stringMatching(/thumbnail\.jpg in the package differs from the manifest/) });
    expect(await edge.store.list(`public-demo/releases/${sealed.manifest.id}/`)).toEqual([]);
    await expectAStillActive(etag);
  });

  it("when the upload is interrupted: B's objects are in the bucket but B is not served and cannot be promoted", async () => {
    const etag = await activeEtag();
    b = await files.package("b");
    // Uploads run in path order, so nine of eleven objects arrive, master.m3u8 among them.
    await expect(publishRelease({ store: failingAfter(edge.store, 9), packageDir: b.directory, promote: true, concurrency: 1 })).rejects.toMatchObject({ step: "upload", message: expect.stringMatching(/connection lost/) });
    const stored = (await edge.store.list(`public-demo/releases/${b.manifest.id}/`)).map((object) => object.key);
    expect(stored).toHaveLength(9);
    expect(stored).toContain(releaseObjectKey(b.manifest.id, "master.m3u8"));
    expect(stored).not.toContain(releaseObjectKey(b.manifest.id, "release.json"));

    for (const file of ["master.m3u8", "360p/index.m3u8", "360p/segment-000.ts"]) expect((await edge.fetch(releaseUrlPath(b.manifest.id, file))).status, file).toBe(404);
    await expect(promoteRelease({ store: edge.store, releaseId: b.manifest.id })).rejects.toMatchObject({ step: "promote", message: expect.stringMatching(/not a complete release/) });
    expect((await readStatus(edge.store)).releases).toContainEqual({ releaseId: b.manifest.id, complete: false, objects: 9, bytes: expect.any(Number) });
    await expectAStillActive(etag);
  });

  it("when an object in the bucket is not the packaged one: the release is not committed, and nothing is overwritten to fix it", async () => {
    const etag = await activeEtag(), polluted = await files.package("x", "release b under another name");
    const key = releaseObjectKey(polluted.manifest.id, "thumbnail.jpg");
    // Something else already sits at one of the release's keys, as after a careless manual upload.
    await edge.bucket.put(key, jpegBytes("not this release"), { httpMetadata: { contentType: "image/jpeg" } });
    await expect(publishRelease({ store: edge.store, packageDir: polluted.directory, promote: true })).rejects.toMatchObject({ step: "verify", message: expect.stringMatching(/thumbnail\.jpg in the bucket differs from the manifest.*No manifest was written/) });
    expect(new Uint8Array((await edge.store.get(key))!.body)).toEqual(jpegBytes("not this release"));
    expect(await edge.store.head(releaseObjectKey(polluted.manifest.id, MANIFEST_NAME))).toBeNull();
    expect((await edge.fetch(releaseUrlPath(polluted.manifest.id, "master.m3u8"))).status).toBe(404);
    await expectAStillActive(etag);

    // The way out deletes nothing: the same content under another label is another version path.
    const again = await files.package("x2", "release b under another name");
    expect(again.manifest.id).not.toBe(polluted.manifest.id);
    expect(await publishRelease({ store: edge.store, packageDir: again.directory })).toMatchObject({ releaseId: again.manifest.id, uploaded: 11, alreadyComplete: false });
    await expectAStillActive(etag);
  });

  it("when an object is stored with the wrong content type: the release is not committed", async () => {
    const etag = await activeEtag(), mistyped = await files.package("y", "mistyped");
    const file = mistyped.manifest.files.find((candidate) => candidate.path === "360p/segment-000.ts")!;
    // The right bytes, but uploaded by hand as a web page.
    await edge.bucket.put(releaseObjectKey(mistyped.manifest.id, file.path), await readFile(path.join(mistyped.directory, "360p", "segment-000.ts")), { httpMetadata: { contentType: "text/html", cacheControl: "public, max-age=31536000, immutable" } });
    await expect(publishRelease({ store: edge.store, packageDir: mistyped.directory })).rejects.toMatchObject({ step: "verify", message: expect.stringMatching(/360p\/segment-000\.ts is stored as text\/html, not video\/mp2t/) });
    expect(await edge.store.head(releaseObjectKey(mistyped.manifest.id, MANIFEST_NAME))).toBeNull();
    await expectAStillActive(etag);
  });

  it("when the manifest cannot be committed: the release stays unserved", async () => {
    const etag = await activeEtag(), late = await files.package("z", "commit");
    const manifestKey = releaseObjectKey(late.manifest.id, MANIFEST_NAME);
    // Between this publisher's verification and its commit, something else takes the manifest key.
    const beaten = withOperation(edge.store, "createOnly", (createOnly) => async (input) => {
      if (input.key === manifestKey) await edge.bucket.put(manifestKey, "{}");
      return createOnly(input);
    });
    await expect(publishRelease({ store: beaten, packageDir: late.directory, promote: true })).rejects.toMatchObject({ step: "commit", message: expect.stringMatching(/different manifest/) });
    expect((await edge.fetch(releaseUrlPath(late.manifest.id, "master.m3u8"))).status).toBe(404);
    await expect(promoteRelease({ store: edge.store, releaseId: late.manifest.id })).rejects.toMatchObject({ step: "promote", message: expect.stringMatching(/invalid manifest/) });
    await expect(publishRelease({ store: edge.store, packageDir: late.directory })).rejects.toMatchObject({ step: "upload", message: expect.stringMatching(/different manifest is already stored.*Nothing was written/) });
    await expectAStillActive(etag);
  });

  it("two publishers of the same package both finish, and one manifest is written", async () => {
    const etag = await activeEtag(), shared = await files.package("w", "shared");
    const results = await Promise.all([publishRelease({ store: edge.store, packageDir: shared.directory }), publishRelease({ store: edge.store, packageDir: shared.directory })]);
    expect(results.map((result) => result.releaseId)).toEqual([shared.manifest.id, shared.manifest.id]);
    expect(results.reduce((total, result) => total + result.uploaded, 0)).toBe(11);
    await verifyRelease(edge.store, shared.manifest.id);
    await expectAStillActive(etag);
  });
});

describe("release B", () => {
  it("resumes after the interruption without re-uploading what arrived, and is served before it is active", async () => {
    const result = await publishRelease({ store: edge.store, packageDir: b.directory });
    expect(result).toMatchObject({ releaseId: b.manifest.id, uploaded: 2, alreadyPresent: 9, alreadyComplete: false });
    expect(result.promotion).toBeUndefined();
    expect(b.manifest.id).not.toBe(a.manifest.id);
    // Its version URLs work now, so it can be checked through the Worker before anyone is sent to it…
    await expectPlayableAndSeekable(b.manifest);
    // …while the active release is still A.
    expect((await current()).body).toMatchObject({ release: a.manifest.id, sequence: 1 });
  });

  it("is promoted by one conditional write, visible on the next request with no purge", async () => {
    // A's files are in the edge cache by now. Promotion must not depend on them leaving it.
    expect((await edge.fetch(releaseUrlPath(a.manifest.id, "master.m3u8"))).headers.get("x-frameflow-cache")).toBe("HIT");
    const result = await promoteRelease({ store: edge.store, releaseId: b.manifest.id, expectActive: a.manifest.id });
    expect(result).toEqual({ changed: true, activeRelease: b.manifest.id, previousRelease: a.manifest.id, sequence: 2 });
    expect((await current()).body).toMatchObject({ release: b.manifest.id, sequence: 2, playlist: `/public-demo/releases/${b.manifest.id}/master.m3u8` });
    expect((await edge.fetch("/public-demo/current.m3u8")).headers.get("location")).toBe(`/public-demo/releases/${b.manifest.id}/master.m3u8`);
    await expectPlayableAndSeekable(b.manifest);
    await expectPlayableAndSeekable(a.manifest);
  });

  it("promoting it again changes nothing", async () => {
    const etag = await activeEtag();
    expect(await promoteRelease({ store: edge.store, releaseId: b.manifest.id })).toMatchObject({ changed: false, sequence: 2 });
    expect(await activeEtag()).toBe(etag);
  });
});

describe("rollback to A", () => {
  it("is one conditional write back to the previous release, and B's version URLs stay usable", async () => {
    const result = await rollbackRelease({ store: edge.store });
    expect(result).toEqual({ changed: true, activeRelease: a.manifest.id, previousRelease: b.manifest.id, sequence: 3 });
    expect((await current()).body).toMatchObject({ release: a.manifest.id, sequence: 3 });
    expect((await edge.fetch("/public-demo/current.m3u8")).headers.get("location")).toBe(`/public-demo/releases/${a.manifest.id}/master.m3u8`);
    await expectPlayableAndSeekable(a.manifest);
    await expectPlayableAndSeekable(b.manifest);
    const status = await readStatus(edge.store);
    expect(status.active).toMatchObject({ activeRelease: a.manifest.id, previousRelease: b.manifest.id, sequence: 3 });
    // Complete means a manifest that is really the release's own. A prefix with objects but no manifest, or with something else at the manifest key, is not.
    expect(Object.fromEntries(status.releases.map((release) => [release.releaseId.split("-")[0], release.complete]))).toEqual({ a: true, b: true, w: true, x: false, x2: true, y: false, z: false });
  });

  it("can name its target, and can be undone the same way", async () => {
    expect(await rollbackRelease({ store: edge.store, to: b.manifest.id })).toMatchObject({ activeRelease: b.manifest.id, sequence: 4 });
    expect(await rollbackRelease({ store: edge.store })).toMatchObject({ activeRelease: a.manifest.id, sequence: 5 });
  });
});

describe("versioned media is never overwritten", () => {
  it("publishing the same package again writes nothing", async () => {
    const before = await edge.store.list(`public-demo/releases/${a.manifest.id}/`);
    expect(await publishRelease({ store: edge.store, packageDir: a.directory })).toMatchObject({ uploaded: 0, alreadyPresent: 0, alreadyComplete: true });
    expect(await edge.store.list(`public-demo/releases/${a.manifest.id}/`)).toEqual(before);
  });

  it("different content under the same label gets a different version path", async () => {
    const other = await files.package("a", "other content");
    expect(other.manifest.label).toBe("a");
    expect(other.manifest.id).not.toBe(a.manifest.id);
  });

  it("a hand-edited manifest cannot claim A's path for other content", async () => {
    const other = await files.package("a", "impostor");
    const forged = JSON.stringify({ ...other.manifest, id: a.manifest.id }, null, 2) + "\n";
    await writeFile(path.join(other.directory, "release.json"), forged);
    await expect(publishRelease({ store: edge.store, packageDir: other.directory })).rejects.toMatchObject({ step: "package", message: expect.stringMatching(/does not produce the release ID/) });
  });

  it("the store refuses to replace an existing object, and A's bytes are unchanged", async () => {
    const key = releaseObjectKey(a.manifest.id, "master.m3u8"), before = await edge.store.get(key);
    expect(await edge.store.createOnly({ key, body: new TextEncoder().encode("#EXTM3U\n# replaced\n"), contentType: "application/vnd.apple.mpegurl", cacheControl: "no-store" })).toEqual({ created: false });
    expect(await edge.store.get(key)).toEqual(before);
    await verifyRelease(edge.store, a.manifest.id);
  });
});

describe("the active reference only moves by a conditional write", () => {
  const state = async () => { const { body } = await current(); return { release: body.release as string, sequence: body.sequence as number }; };

  it("a promotion that lost a race writes nothing", async () => {
    const before = await state();
    expect(before.release).toBe(a.manifest.id);
    // While this promotion of B is between reading the reference and writing it, another operator promotes B and rolls back.
    let interfered = false;
    const racing = withOperation(edge.store, "replaceIfMatch", (replaceIfMatch) => async (input) => {
      if (!interfered) { interfered = true; await promoteRelease({ store: edge.store, releaseId: b.manifest.id }); await rollbackRelease({ store: edge.store }); }
      return replaceIfMatch(input);
    });
    await expect(promoteRelease({ store: racing, releaseId: b.manifest.id })).rejects.toMatchObject({ step: "promote", message: expect.stringMatching(/changed while promoting. Nothing was overwritten/) });
    // The other operator's result stands: A is active, two changes later.
    expect(await state()).toEqual({ release: a.manifest.id, sequence: before.sequence + 2 });
  });

  it("a promotion whose write landed but whose answer was lost is reported as done, not as a conflict", async () => {
    const before = await state();
    // The store applies the write, and the publisher is told the condition failed, as when a retry follows a lost response.
    const deaf = withOperation(edge.store, "replaceIfMatch", (replaceIfMatch) => async (input) => { await replaceIfMatch(input); return { replaced: false }; });
    expect(await promoteRelease({ store: deaf, releaseId: b.manifest.id })).toEqual({ changed: true, activeRelease: b.manifest.id, previousRelease: a.manifest.id, sequence: before.sequence + 1 });
    expect(await state()).toEqual({ release: b.manifest.id, sequence: before.sequence + 1 });
    await rollbackRelease({ store: edge.store });
  });

  it("of two promotions of the same release from the same state, one writes and neither fails", async () => {
    const before = await state();
    // Different clocks, so the two attempts would write different bytes and can be told apart afterwards.
    const results = await Promise.all([new Date("2026-11-22T10:00:00.000Z"), new Date("2026-11-22T10:00:00.001Z")].map((time) => promoteRelease({ store: edge.store, releaseId: b.manifest.id, expectActive: a.manifest.id, now: () => time }).catch((error: unknown) => error)));
    // Either both raced and one lost the condition, or the second ran after the first: it then finds B active, or its expectation of A unmet. Never two writes.
    expect(results.filter((result) => !(result instanceof Error) && (result as { changed: boolean }).changed)).toHaveLength(1);
    for (const result of results) if (result instanceof Error) expect(result.message).toMatch(/Expected .* to be active/);
    expect(await state()).toEqual({ release: b.manifest.id, sequence: before.sequence + 1 });
    await rollbackRelease({ store: edge.store });
  });

  it("refuses when the release expected to be active is not", async () => {
    const before = await state();
    await expect(promoteRelease({ store: edge.store, releaseId: b.manifest.id, expectActive: b.manifest.id })).rejects.toMatchObject({ step: "promote", message: expect.stringMatching(/Expected .* to be active.*Nothing was written/) });
    await expect(promoteRelease({ store: edge.store, releaseId: b.manifest.id, expectActive: null })).rejects.toMatchObject({ step: "promote" });
    expect(await state()).toEqual(before);
  });

  it("refuses a release that does not exist, is malformed, or was damaged in the bucket", async () => {
    const before = await state();
    await expect(promoteRelease({ store: edge.store, releaseId: "c-0000000000000000" })).rejects.toMatchObject({ step: "promote", message: expect.stringMatching(/not a complete release/) });
    await expect(promoteRelease({ store: edge.store, releaseId: "../../private" })).rejects.toMatchObject({ step: "promote", message: expect.stringMatching(/not a release ID/) });

    const c = await files.package("c");
    await publishRelease({ store: edge.store, packageDir: c.directory });
    // Out-of-band damage, which the publisher itself can never cause: same key, different bytes.
    await edge.bucket.put(releaseObjectKey(c.manifest.id, "360p/segment-001.ts"), new Uint8Array(40 * 188).fill(0x47));
    await expect(promoteRelease({ store: edge.store, releaseId: c.manifest.id })).rejects.toMatchObject({ step: "promote", message: expect.stringMatching(/damaged in the bucket: 360p\/segment-001\.ts/) });
    await expect(verifyRelease(edge.store, c.manifest.id)).rejects.toMatchObject({ step: "verify" });
    expect(await state()).toEqual(before);
  });

  it("of two first promotions on an empty bucket, one creates the reference and the other does not overwrite it", async () => {
    const fresh = await startLocalEdge();
    try {
      const first = await files.package("first"), second = await files.package("second");
      await publishRelease({ store: fresh.store, packageDir: first.directory });
      await publishRelease({ store: fresh.store, packageDir: second.directory });
      // Both operators read "no active release". The second one's create-only write then arrives after the first's.
      let interfered = false;
      const racing = withOperation(fresh.store, "createOnly", (createOnly) => async (input) => {
        if (input.key === ACTIVE_REFERENCE_KEY && !interfered) { interfered = true; await promoteRelease({ store: fresh.store, releaseId: first.manifest.id, expectActive: null }); }
        return createOnly(input);
      });
      await expect(promoteRelease({ store: racing, releaseId: second.manifest.id, expectActive: null })).rejects.toMatchObject({ step: "promote", message: expect.stringMatching(/Nothing was overwritten/) });
      expect(await (await fresh.fetch("/public-demo/current.json")).json()).toMatchObject({ release: first.manifest.id, sequence: 1 });
    } finally { await fresh.dispose(); }
  });

  it("has nothing to roll back to without a previous release", async () => {
    const fresh = await startLocalEdge();
    try {
      await expect(rollbackRelease({ store: fresh.store })).rejects.toMatchObject({ message: expect.stringMatching(/No release is active/) });
      const only = await files.package("only");
      await publishRelease({ store: fresh.store, packageDir: only.directory, promote: true });
      await expect(rollbackRelease({ store: fresh.store })).rejects.toMatchObject({ message: expect.stringMatching(/no previous release recorded/) });
    } finally { await fresh.dispose(); }
  });
});

describe("packaging", () => {
  it("refuses a directory that holds anything a release may not contain", async () => {
    const directory = path.join(files.root, "with-source");
    await writeReleaseFiles(directory, "x");
    await writeFile(path.join(directory, "source.mp4"), "the private original");
    await expect(sealPackage(directory, "x")).rejects.toThrow(ReleaseValidationError);
    await expect(sealPackage(directory, "x")).rejects.toThrow(/source\.mp4, which is not a file a release may contain/);
  });

  it("refuses a segment no playlist references", async () => {
    const directory = path.join(files.root, "with-extra-segment");
    await writeReleaseFiles(directory, "x");
    await writeFile(path.join(directory, "720p", "segment-007.ts"), new Uint8Array(188).fill(0x47));
    await expect(sealPackage(directory, "x")).rejects.toThrow(/720p\/segment-007\.ts, which no playlist references/);
  });

  it("refuses media that is not what its name says", async () => {
    for (const [file, pattern] of [["360p/segment-000.ts", /not an MPEG-TS segment/], ["thumbnail.jpg", /not a complete JPEG/], ["preview.mp4", /not an MP4/]] as const) {
      const directory = path.join(files.root, `bad-${file.replace(/\W/g, "-")}`);
      await writeReleaseFiles(directory, "x");
      await writeFile(path.join(directory, ...file.split("/")), "<html>not media</html>");
      await expect(sealPackage(directory, "x"), file).rejects.toThrow(pattern);
    }
  });
});
