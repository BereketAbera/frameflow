/**
 * The Worker's HTTP behaviour, against the built bundle in workerd with a local R2 bucket and the runtime's local
 * cache. The cache here is a simulation: these tests prove what the Worker asks of the cache and what it does with
 * the answer, not what Cloudflare's edge does.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promoteRelease, publishRelease, rollbackRelease } from "../src/publisher/releases.js";
import { IMMUTABLE_CACHE_CONTROL, releaseObjectKey, releaseUrlPath, type ReleaseManifest } from "../src/shared/contract.js";
import { edgeRoot } from "../local/build-worker.js";
import { startLocalEdge, untilCached, type LocalEdge } from "../local/runtime.js";
import { segmentBytes, sha256Hex, workspace, type Workspace } from "./support/fixtures.js";

let edge: LocalEdge, files: Workspace, a: ReleaseManifest, b: ReleaseManifest;
const url = (manifest: ReleaseManifest, file: string) => releaseUrlPath(manifest.id, file);
const entry = (manifest: ReleaseManifest, file: string) => manifest.files.find((candidate) => candidate.path === file)!;
const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());

type RawResponse = { status: number; body: string; headers: Record<string, string | string[] | undefined> };
/** Sends the method and the path exactly as written. fetch() would resolve ".." and refuse unusual methods before the request left the test. */
function raw(rawPath: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<RawResponse> {
  const { hostname, port } = new URL(edge.origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname, port, path: rawPath, method: options.method ?? "GET", headers: options.headers }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; }).on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
    });
    request.on("error", reject).end();
  });
}

type FreshFile = { target: string; whole: Uint8Array; etag: string; manifest: ReleaseManifest };
/** A release nothing has requested yet: one file of it, its bytes and its ETag. */
async function freshFile(seed: string): Promise<FreshFile> {
  const fresh = await files.package("r", seed);
  await publishRelease({ store: edge.store, packageDir: fresh.directory });
  return { target: url(fresh.manifest, "360p/segment-000.ts"), whole: segmentBytes(40, `${seed}/360p/0`), etag: `"${entry(fresh.manifest, "360p/segment-000.ts").sha256}"`, manifest: fresh.manifest };
}

/**
 * Runs one check against a file this location does not hold yet (answered from the bucket) and again once it does
 * (answered from the cache). The two answers must be the same HTTP: that is the point of every test that uses this.
 */
async function onMissAndOnHit(seed: string, check: (file: FreshFile, state: "MISS" | "HIT") => Promise<void>): Promise<void> {
  const cold = await freshFile(`${seed} cold`);
  await check(cold, "MISS");
  const warm = await freshFile(`${seed} warm`);
  await bytesOf(await edge.fetch(warm.target));
  await bytesOf(await untilCached(edge, warm.target));
  await check(warm, "HIT");
}

beforeAll(async () => {
  edge = await startLocalEdge();
  files = await workspace();
  const packageA = await files.package("a"), packageB = await files.package("b");
  a = packageA.manifest; b = packageB.manifest;
  await publishRelease({ store: edge.store, packageDir: packageA.directory, promote: true });
  await publishRelease({ store: edge.store, packageDir: packageB.directory });
});
afterAll(async () => { await edge.dispose(); await files.cleanup(); });

describe("only the public demo path is served", () => {
  const SECRET = "owner-only material that must never leave the bucket";
  const incomplete = "c-00000000000000c0";
  const expand = (template: string) => template.replace("/A", `/${a.id}`).replace("INCOMPLETE", incomplete);

  beforeAll(async () => {
    const planted: Record<string, string | Uint8Array> = {
      // Private objects, at the keys Frameflow's private bucket uses, in case one is ever put here by mistake.
      "private/owner-notes.txt": SECRET,
      "videos/abc/source/source.mp4": SECRET,
      "videos/abc/published/master.m3u8": `#EXTM3U\n# ${SECRET}\n`,
      "owner-only.txt": SECRET,
      // Inside the public prefix, but not part of any release.
      "public-demo/notes.txt": SECRET,
      "public-demo/releases/notes.txt": SECRET,
      // Inside release A's own prefix, but not listed in its manifest.
      [releaseObjectKey(a.id, "source.mp4")]: SECRET,
      [releaseObjectKey(a.id, "720p/segment-999.ts")]: segmentBytes(2, SECRET),
      [releaseObjectKey(a.id, "1080p/index.m3u8")]: `#EXTM3U\n# ${SECRET}\n`,
      [releaseObjectKey(a.id, "thumbnail.jpg.bak")]: SECRET,
      // A release that never completed: its files are there, its manifest is not.
      [releaseObjectKey(incomplete, "master.m3u8")]: `#EXTM3U\n# ${SECRET}\n`,
      [releaseObjectKey(incomplete, "360p/segment-000.ts")]: segmentBytes(2, SECRET),
    };
    for (const [key, value] of Object.entries(planted)) await edge.bucket.put(key, value);
  });

  const forbidden = [
    "/", "/favicon.ico", "/robots.txt", "/private/owner-notes.txt", "/videos/abc/source/source.mp4", "/videos/abc/published/master.m3u8", "/owner-only.txt",
    "/public-demox", "/public-demo/notes.txt", "/public-demo/releases/notes.txt", "/public-demo/releases/", "/public-demo/releases",
    // The stored pointer and the manifests are the publisher's, not the public's.
    "/public-demo/active.json", "/public-demo/releases/A/release.json",
    "/public-demo/releases/A/source.mp4", "/public-demo/releases/A/720p/segment-999.ts", "/public-demo/releases/A/1080p/index.m3u8", "/public-demo/releases/A/thumbnail.jpg.bak",
    "/public-demo/releases/A/", "/public-demo/releases/A", "/public-demo/releases/A/720p/", "/public-demo/releases/A/master.m3u8/",
    "/public-demo/releases/INCOMPLETE/master.m3u8", "/public-demo/releases/INCOMPLETE/360p/segment-000.ts",
    "/public-demo/releases/c-0000000000000000/master.m3u8", "/public-demo/releases/not-an-id/master.m3u8",
    // Ways of trying to leave the release prefix.
    "/public-demo/../private/owner-notes.txt", "/public-demo/releases/A/../../../private/owner-notes.txt", "/public-demo/releases/A/../../notes.txt",
    "/public-demo/releases/A/%2e%2e/%2e%2e/%2e%2e/private/owner-notes.txt", "/public-demo/releases/A/..%2f..%2f..%2fprivate%2fowner-notes.txt",
    "/public-demo/releases/A/%2e%2e%2f%2e%2e%2fnotes.txt", "/public-demo/releases/A/720p/..%5c..%5csource.mp4", "/public-demo/releases/A//source.mp4",
    "/public-demo//private/owner-notes.txt", "//private/owner-notes.txt", "/public-demo/releases/A/master.m3u8%00.txt", "/public-demo/releases/A/MASTER.M3U8",
    "/public-demo/releases/A/source%2emp4", "/PUBLIC-DEMO/current.json",
  ];

  it.each(forbidden)("answers 404 for %s", async (template) => {
    for (const method of ["GET", "HEAD"]) {
      const response = await raw(expand(template), { method });
      expect([method, response.status, response.headers["cache-control"]]).toEqual([method, 404, "no-store"]);
      expect(response.body).not.toContain("owner-only");
    }
  });

  it("still serves the listed files beside the planted ones", async () => {
    expect((await edge.fetch(url(a, "master.m3u8"))).status).toBe(200);
    expect((await edge.fetch(url(a, "720p/segment-000.ts"))).status).toBe(200);
  });

  it("answers 404 for anything with a query string, so a URL cannot be multiplied into cache keys", async () => {
    for (const target of [`${url(a, "master.m3u8")}?v=2`, `${url(a, "720p/segment-000.ts")}?x`, "/public-demo/current.json?x=1", "/public-demo/current.m3u8?release=x"]) expect([target, (await raw(target)).status]).toEqual([target, 404]);
    // A bare "?" is no query at all.
    expect((await raw(`${url(a, "720p/segment-000.ts")}?`)).status).toBe(200);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "PROPFIND", "MKCOL", "COPY", "MOVE", "LOCK", "PURGE"])("refuses %s everywhere and changes nothing", async (method) => {
    for (const target of [url(a, "master.m3u8"), "/public-demo/current.json", "/public-demo/", "/public-demo/active.json", url(a, "new-file.ts")]) {
      const response = await raw(target, { method, headers: { destination: `${edge.origin}/public-demo/releases/${a.id}/copied.ts` } });
      expect([target, response.status, response.headers.allow, response.headers["cache-control"]]).toEqual([target, 405, "GET, HEAD, OPTIONS", "no-store"]);
    }
    expect(await sha256Hex(await bytesOf(await edge.fetch(url(a, "master.m3u8"))))).toBe(entry(a, "master.m3u8").sha256);
    expect(await edge.store.head(releaseObjectKey(a.id, "new-file.ts"))).toBeNull();
    expect(await edge.store.head(releaseObjectKey(a.id, "copied.ts"))).toBeNull();
  });

  it("refuses those methods outside the public path as plain 404s", async () => {
    expect((await raw("/private/owner-notes.txt", { method: "DELETE" })).status).toBe(404);
    expect(await (await edge.bucket.get("private/owner-notes.txt"))!.text()).toBe(SECRET);
  });

  it("takes the method and the path from the request line only, whatever headers claim", async () => {
    const overrides = { "x-http-method-override": "DELETE", "x-http-method": "PUT", "x-method-override": "DELETE", "x-original-url": "/private/owner-notes.txt", "x-rewrite-url": "/private/owner-notes.txt", "x-forwarded-host": "private.example", forwarded: "host=private.example" };
    const listed = await raw(url(a, "master.m3u8"), { headers: overrides });
    expect([listed.status, listed.headers["content-type"]]).toEqual([200, "application/vnd.apple.mpegurl"]);
    expect(await sha256Hex(new TextEncoder().encode(listed.body))).toBe(entry(a, "master.m3u8").sha256);
    const outside = await raw("/", { headers: { ...overrides, "x-original-url": url(a, "master.m3u8"), "x-rewrite-url": "/public-demo/current.json" } });
    expect(outside.status).toBe(404);
    expect(await (await edge.bucket.get("private/owner-notes.txt"))!.text()).toBe(SECRET);
    expect(await edge.store.head(releaseObjectKey(a.id, "master.m3u8"))).not.toBeNull();
  });
});

describe("release files", () => {
  it.each([
    ["master.m3u8", "application/vnd.apple.mpegurl"], ["360p/index.m3u8", "application/vnd.apple.mpegurl"], ["720p/segment-001.ts", "video/mp2t"],
    ["thumbnail.jpg", "image/jpeg"], ["preview.mp4", "video/mp4"],
  ])("%s is served as %s, immutable for a year, with its checksum as ETag", async (file, contentType) => {
    const listed = entry(b, file);
    for (const state of ["MISS", "HIT"]) {
      const response = state === "MISS" ? await edge.fetch(url(b, file)) : await untilCached(edge, url(b, file));
      expect([state, response.status, response.headers.get("x-frameflow-cache")]).toEqual([state, 200, state]);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(response.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
      expect(response.headers.get("etag")).toBe(`"${listed.sha256}"`);
      expect(response.headers.get("content-length")).toBe(String(listed.size));
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("x-frameflow-release")).toBe(b.id);
      expect(response.headers.get("set-cookie")).toBeNull();
      // The size header exists only on the copy kept in the cache.
      expect(response.headers.get("x-frameflow-size")).toBeNull();
      expect(await sha256Hex(await bytesOf(response))).toBe(listed.sha256);
    }
  });

  it("the first request is a MISS read from the bucket, and the repeat at this location is a HIT", async () => {
    const target = url(a, "720p/segment-002.ts"), first = await edge.fetch(target), firstBytes = await bytesOf(first);
    expect(first.headers.get("x-frameflow-cache")).toBe("MISS");
    expect(first.headers.get("cf-cache-status")).toBeNull();
    const second = await untilCached(edge, target);
    expect(second.headers.get("x-frameflow-cache")).toBe("HIT");
    expect(second.headers.get("cf-cache-status")).toBe("HIT");
    expect(second.headers.get("x-frameflow-colo")).toBe(first.headers.get("x-frameflow-colo"));
    expect(second.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(second.headers.get("content-type")).toBe("video/mp2t");
    expect(await bytesOf(second)).toEqual(firstBytes);
  });

  it("a HIT is served without the bucket", async () => {
    const d = await files.package("d");
    await publishRelease({ store: edge.store, packageDir: d.directory });
    const target = url(d.manifest, "360p/segment-000.ts");
    const original = await bytesOf(await edge.fetch(target));
    await bytesOf(await untilCached(edge, target));
    await edge.bucket.delete(releaseObjectKey(d.manifest.id, "360p/segment-000.ts"));
    for (const init of [{}, { headers: { range: "bytes=100-199" } }]) {
      const afterDelete = await edge.fetch(target, init);
      expect([afterDelete.status, afterDelete.headers.get("x-frameflow-cache")]).toEqual(["headers" in init ? 206 : 200, "HIT"]);
      expect(await bytesOf(afterDelete)).toEqual("headers" in init ? original.subarray(100, 200) : original);
    }
    // A file of the same release that was never requested here has no cached copy to fall back on.
    await edge.bucket.delete(releaseObjectKey(d.manifest.id, "360p/segment-001.ts"));
    expect((await edge.fetch(url(d.manifest, "360p/segment-001.ts"))).status).toBe(502);
  });

  it("HEAD does not fill the cache", async () => {
    const { target } = await freshFile("head only");
    expect((await edge.fetch(target, { method: "HEAD" })).headers.get("x-frameflow-cache")).toBe("MISS");
    expect((await edge.fetch(target, { method: "HEAD" })).headers.get("x-frameflow-cache")).toBe("MISS");
    expect((await edge.fetch(target)).headers.get("x-frameflow-cache")).toBe("MISS");
  });
});

describe("a cache hit and a cache miss answer the same request the same way", () => {
  it.each([
    ["bytes=0-", 0, 7519], ["bytes=0-0", 0, 0], ["bytes=7000-", 7000, 7519], ["bytes=-20", 7500, 7519], ["bytes=10-99999999", 10, 7519], ["bytes=7519-7519", 7519, 7519],
    ["bytes=-99999999", 0, 7519], ["bytes=188-375", 188, 375], [" bytes=5-9 ", 5, 9],
  ])("Range: %s is that range", async (range, start, end) => {
    await onMissAndOnHit(`range ${range}`, async ({ target, whole }, state) => {
      const response = await edge.fetch(target, { headers: { range } });
      expect([state, response.status, response.headers.get("content-range"), response.headers.get("content-length"), response.headers.get("x-frameflow-cache")]).toEqual([state, 206, `bytes ${start}-${end}/7520`, String(end - start + 1), state]);
      expect(response.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
      expect(response.headers.get("content-type")).toBe("video/mp2t");
      expect(await bytesOf(response)).toEqual(whole.subarray(start, end + 1));
    });
  });

  it.each(["bytes=7520-", "bytes=99999-100000", "bytes=-0"])("Range: %s is 416, not a body, and not cacheable", async (range) => {
    await onMissAndOnHit(`beyond ${range}`, async ({ target }, state) => {
      const response = await edge.fetch(target, { headers: { range } });
      expect([state, response.status, response.headers.get("content-range"), response.headers.get("cache-control")]).toEqual([state, 416, "bytes */7520", "no-store"]);
      expect([response.headers.get("access-control-allow-origin"), response.headers.get("x-content-type-options")]).toEqual(["*", "nosniff"]);
      expect(await response.text()).toBe("Range not satisfiable\n");
    });
  });

  it.each(["bytes=0-9,20-29", "items=0-9", "bytes=9-0", "bytes=abc", "bytes=-", "0-9", "bytes=1234567890123456-", "bytes=0-1234567890123456"])("the unusable Range %j is ignored and the whole object is sent", async (range) => {
    await onMissAndOnHit(`ignored ${range}`, async ({ target, whole }, state) => {
      const response = await edge.fetch(target, { headers: { range } });
      expect([state, response.status, response.headers.get("content-length"), response.headers.get("content-range"), response.headers.get("content-type")]).toEqual([state, 200, "7520", null, "video/mp2t"]);
      expect(await bytesOf(response)).toEqual(whole);
    });
  });

  it("If-Range applies the range only for this exact object", async () => {
    await onMissAndOnHit("if-range stale", async ({ target, whole }, state) => {
      const stale = await edge.fetch(target, { headers: { range: "bytes=0-9", "if-range": '"stale-validator"' } });
      expect([state, stale.status, stale.headers.get("content-length")]).toEqual([state, 200, "7520"]);
      expect(await bytesOf(stale)).toEqual(whole);
    });
    await onMissAndOnHit("if-range dated", async ({ target }, state) => {
      const dated = await edge.fetch(target, { headers: { range: "bytes=0-9", "if-range": "Sat, 21 Nov 2026 10:00:00 GMT" } });
      expect([state, dated.status, (await bytesOf(dated)).length]).toEqual([state, 200, 7520]);
    });
    await onMissAndOnHit("if-range current", async ({ target, whole, etag }, state) => {
      const current = await edge.fetch(target, { headers: { range: "bytes=0-9", "if-range": etag } });
      expect([state, current.status, current.headers.get("content-range")]).toEqual([state, 206, "bytes 0-9/7520"]);
      expect(await bytesOf(current)).toEqual(whole.subarray(0, 10));
    });
  });

  it.each<Record<string, string>>([{}, { range: "bytes=0-9" }, { range: "bytes=7520-" }, { range: "bytes=abc" }])("HEAD with %j answers with the full length and no body", async (headers) => {
    await onMissAndOnHit(`head ${JSON.stringify(headers)}`, async ({ target, etag }, state) => {
      const response = await edge.fetch(target, { method: "HEAD", headers });
      expect([state, response.status, response.headers.get("content-length"), response.headers.get("content-range"), response.headers.get("x-frameflow-cache")]).toEqual([state, 200, "7520", null, state]);
      expect([response.headers.get("etag"), response.headers.get("cache-control")]).toEqual([etag, IMMUTABLE_CACHE_CONTROL]);
      expect((await bytesOf(response)).length).toBe(0);
    });
  });

  it("If-None-Match answers 304 with no body, also when a range was asked for", async () => {
    await onMissAndOnHit("revalidate", async ({ target, etag }, state) => {
      const revalidations: Record<string, string>[] = [{ "if-none-match": etag }, { "if-none-match": `W/${etag}, "other"` }, { "if-none-match": "*" }, { "if-none-match": etag, range: "bytes=0-9" }, { "if-none-match": etag, range: "bytes=7520-" }];
      for (const headers of revalidations) {
        for (const method of ["GET", "HEAD"]) {
          const response = await edge.fetch(target, { method, headers });
          expect([state, method, JSON.stringify(headers), response.status, response.headers.get("etag"), response.headers.get("x-frameflow-cache"), response.headers.get("cache-control")]).toEqual([state, method, JSON.stringify(headers), 304, etag, state, IMMUTABLE_CACHE_CONTROL]);
          expect([response.headers.get("content-range"), (await bytesOf(response)).length]).toEqual([null, 0]);
        }
      }
    });
    await onMissAndOnHit("no match", async ({ target, whole }, state) => {
      const response = await edge.fetch(target, { headers: { "if-none-match": '"something-else"' } });
      expect([state, response.status]).toEqual([state, 200]);
      expect(await bytesOf(response)).toEqual(whole);
    });
  });
});

describe("partial responses are never stored as whole objects", () => {
  it("a ranged first request gets 206 from the bucket, and what the cache then holds is the complete object", async () => {
    const { target, whole } = await freshFile("partial");
    const ranged = await edge.fetch(target, { headers: { range: "bytes=100-299" } });
    expect([ranged.status, ranged.headers.get("content-range"), ranged.headers.get("content-length"), ranged.headers.get("x-frameflow-cache")]).toEqual([206, "bytes 100-299/7520", "200", "MISS"]);
    expect(ranged.headers.get("cf-cache-status")).toBeNull();
    expect(await bytesOf(ranged)).toEqual(whole.subarray(100, 300));

    // Whatever is served for the whole URL afterwards, hit or miss, is the whole object and never those 200 bytes.
    for (let attempt = 0; attempt < 3; attempt++) {
      const full = await edge.fetch(target);
      expect([full.status, full.headers.get("content-length")]).toEqual([200, "7520"]);
      expect(await bytesOf(full)).toEqual(whole);
    }
    const cached = await untilCached(edge, target);
    expect([cached.status, cached.headers.get("x-frameflow-cache"), cached.headers.get("content-length")]).toEqual([200, "HIT", "7520"]);
    expect(await bytesOf(cached)).toEqual(whole);
  });

  it("a ranged first request alone fills the cache with the whole object, in the background", async () => {
    const { target, whole } = await freshFile("background fill");
    expect((await edge.fetch(target, { headers: { range: "bytes=0-0" } })).status).toBe(206);
    const cached = await untilCached(edge, target);
    expect([cached.headers.get("x-frameflow-cache"), cached.headers.get("content-length")]).toEqual(["HIT", "7520"]);
    expect(await bytesOf(cached)).toEqual(whole);
  });

  it("a burst of ranged first requests leaves one complete object in the cache", async () => {
    const { target, whole } = await freshFile("burst");
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => edge.fetch(target, { headers: { range: `bytes=${index * 100}-${index * 100 + 99}` } })));
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(206);
      expect(await bytesOf(response)).toEqual(whole.subarray(index * 100, index * 100 + 100));
    }
    expect(await bytesOf(await untilCached(edge, target))).toEqual(whole);
  });

  it("a viewer that stops reading a range early does not disturb later requests", async () => {
    const { target, whole } = await freshFile("abandoned");
    await bytesOf(await edge.fetch(target));
    await bytesOf(await untilCached(edge, target));
    const abandoned = await edge.fetch(target, { headers: { range: "bytes=0-7000" } });
    await abandoned.body!.cancel();
    const next = await edge.fetch(target, { headers: { range: "bytes=7000-7519" } });
    expect([next.status, next.headers.get("x-frameflow-cache")]).toEqual([206, "HIT"]);
    expect(await bytesOf(next)).toEqual(whole.subarray(7000));
  });
});

describe("an object that is not the published one is refused and never cached", () => {
  it.each([
    ["different bytes of the same length", () => segmentBytes(40, "tampered")],
    ["a truncated object", () => segmentBytes(40, "x").subarray(0, 188 * 10)],
    ["a longer object", () => segmentBytes(80, "x")],
  ])("%s", async (name, replacement) => {
    const { target, manifest } = await freshFile(`tamper ${name}`);
    // Out-of-band damage. The publisher cannot do this: it has no unconditional write and no delete.
    await edge.bucket.put(releaseObjectKey(manifest.id, "360p/segment-000.ts"), replacement());
    for (const init of [{}, { headers: { range: "bytes=0-99" } }, { method: "HEAD" }, {}]) {
      const response = await edge.fetch(target, init);
      expect([response.status, response.headers.get("cache-control"), response.headers.get("x-frameflow-cache")]).toEqual([502, "no-store", "BYPASS"]);
      await bytesOf(response);
    }
    // The rest of the release is unaffected.
    expect((await edge.fetch(url(manifest, "360p/segment-001.ts"))).status).toBe(200);
  });
});

describe("the active release", () => {
  it("is resolved from the bucket on every request and never stored", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await edge.fetch("/public-demo/current.json");
      expect([response.status, response.headers.get("cache-control"), response.headers.get("x-frameflow-cache"), response.headers.get("cf-cache-status")]).toEqual([200, "no-store", "BYPASS", null]);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("etag")).toBeNull();
      expect(await response.json()).toMatchObject({ release: a.id, durationSeconds: 10, renditions: [{ name: "360p", width: 640, height: 360 }, { name: "720p", width: 1280, height: 720 }] });
    }
    const redirect = await edge.fetch("/public-demo/current.m3u8");
    expect([redirect.status, redirect.headers.get("location"), redirect.headers.get("cache-control"), redirect.headers.get("cf-cache-status")]).toEqual([302, url(a, "master.m3u8"), "no-store", null]);
  });

  it("follows a promotion and a rollback on the very next request", async () => {
    const releaseNow = async () => ((await (await edge.fetch("/public-demo/current.json")).json()) as { release: string }).release;
    const targetNow = async () => (await edge.fetch("/public-demo/current.m3u8")).headers.get("location");
    expect(await releaseNow()).toBe(a.id);
    await promoteRelease({ store: edge.store, releaseId: b.id });
    expect([await releaseNow(), await targetNow()]).toEqual([b.id, url(b, "master.m3u8")]);
    await rollbackRelease({ store: edge.store });
    expect([await releaseNow(), await targetNow()]).toEqual([a.id, url(a, "master.m3u8")]);
    // Both versions are still there, whichever is active.
    expect((await edge.fetch(url(a, "master.m3u8"))).status).toBe(200);
    expect((await edge.fetch(url(b, "master.m3u8"))).status).toBe(200);
  });

  it("exposes no publisher state: not the previous release, not checksums, not bucket keys", async () => {
    const body = await (await edge.fetch("/public-demo/current.json")).text();
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(["durationSeconds", "playlist", "preview", "release", "renditions", "sequence", "thumbnail", "updatedAt"]);
    expect(body).not.toMatch(/previous|sha256|md5|etag/i);
  });

  it("answers 404 when the stored reference is damaged or names a release that is not complete", async () => {
    const fresh = await startLocalEdge();
    try {
      for (const stored of ["not json", JSON.stringify({ schemaVersion: 1, activeRelease: "../private", previousRelease: null, sequence: 1, updatedAt: "2026-11-22T00:00:00.000Z" }), JSON.stringify({ schemaVersion: 1, activeRelease: "z-0000000000000000", previousRelease: null, sequence: 1, updatedAt: "2026-11-22T00:00:00.000Z" })]) {
        await fresh.bucket.put("public-demo/active.json", stored);
        const json = await fresh.fetch("/public-demo/current.json"), playlist = await fresh.fetch("/public-demo/current.m3u8");
        expect([json.status, json.headers.get("cache-control"), playlist.status, playlist.headers.get("cache-control"), playlist.headers.get("location")]).toEqual([404, "no-store", 404, "no-store", null]);
      }
    } finally { await fresh.dispose(); }
  });
});

describe("every response says how it may be cached", () => {
  it("only complete release files are cacheable, and everything else is no-store", async () => {
    const warm = url(a, "360p/segment-001.ts");
    await bytesOf(await edge.fetch(warm));
    await bytesOf(await untilCached(edge, warm));
    const requests: Array<[string, RequestInit?]> = [
      ["/"], ["/public-demo"], ["/public-demo/"], ["/public-demo/current.json"], ["/public-demo/current.m3u8"], ["/public-demo/active.json"], ["/public-demo/nothing"],
      [url(a, "nothing.ts")], [url(a, "master.m3u8"), { method: "POST" }], [url(a, "master.m3u8"), { method: "OPTIONS" }], [url(b, "360p/segment-000.ts"), { headers: { range: "bytes=999999-" } }],
      [warm, { headers: { range: "bytes=999999-" } }], [warm, { headers: { range: "bytes=0-9,20-29" } }], [warm, { method: "HEAD", headers: { range: "bytes=999999-" } }],
      [url(a, "master.m3u8")], [url(a, "master.m3u8"), { method: "HEAD" }], [url(a, "360p/segment-000.ts"), { headers: { range: "bytes=0-9" } }], [warm], [warm, { headers: { range: "bytes=0-9" } }],
    ];
    for (const [target, init] of requests) {
      const response = await edge.fetch(target, init), cacheControl = response.headers.get("cache-control");
      const releaseFile = target.includes("/releases/") && [200, 206, 304].includes(response.status);
      expect([target, init?.method ?? "GET", response.status, cacheControl]).toEqual([target, init?.method ?? "GET", response.status, releaseFile ? IMMUTABLE_CACHE_CONTROL : "no-store"]);
      await bytesOf(response);
    }
  });
});

describe("cross-origin players", () => {
  it("may read the public sample from any origin", async () => {
    const preflight = await edge.fetch(url(a, "master.m3u8"), { method: "OPTIONS", headers: { origin: "https://frameflow.example", "access-control-request-method": "GET", "access-control-request-headers": "range" } });
    expect([preflight.status, preflight.headers.get("access-control-allow-origin"), preflight.headers.get("access-control-allow-methods")]).toEqual([204, "*", "GET, HEAD, OPTIONS"]);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("range");
    await onMissAndOnHit("cors", async ({ target }, state) => {
      const response = await edge.fetch(target, { headers: { origin: "https://frameflow.example", range: "bytes=0-9" } });
      expect([state, response.headers.get("access-control-allow-origin"), response.headers.get("access-control-allow-credentials")]).toEqual([state, "*", null]);
      expect(response.headers.get("access-control-expose-headers")).toContain("content-range");
      await bytesOf(response);
    });
  });
});

describe("the demo player page", () => {
  const sha256Base64 = (text: string) => createHash("sha256").update(text).digest("base64");

  it("is served only at /public-demo/ and allows exactly its own scripts and styles", async () => {
    const response = await edge.fetch("/public-demo/?release=" + b.id), html = await response.text(), policy = response.headers.get("content-security-policy")!;
    expect([response.status, response.headers.get("content-type"), response.headers.get("cache-control")]).toEqual([200, "text/html; charset=utf-8", "no-store"]);
    expect(response.headers.get("x-frame-options")).toBe("DENY");

    const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!), styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]!);
    expect([inlineScripts.length, styles.length]).toEqual([1, 1]);
    expect(policy).toContain(`script-src 'sha256-${sha256Base64(inlineScripts[0]!)}' https://cdn.jsdelivr.net/npm/hls.js@`);
    expect(policy).toContain(`style-src 'sha256-${sha256Base64(styles[0]!)}'`);
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    // The policy is the same on a later request, and the page takes nothing from the request into its markup.
    expect((await edge.fetch("/public-demo/")).headers.get("content-security-policy")).toBe(policy);
    expect(html).not.toContain(b.id);
    expect(await (await edge.fetch('/public-demo/?release="><script>alert(1)</script>')).text()).toBe(html);
  });

  it("redirects /public-demo to it and keeps the chosen release", async () => {
    const bare = await edge.fetch("/public-demo"), chosen = await edge.fetch(`/public-demo?release=${b.id}`);
    expect([bare.status, bare.headers.get("location"), bare.headers.get("cache-control")]).toEqual([308, "/public-demo/", "no-store"]);
    expect([chosen.status, chosen.headers.get("location")]).toEqual([308, `/public-demo/?release=${b.id}`]);
    // The redirect target is always this page, whatever the query holds.
    const odd = await raw("/public-demo?release=//evil.example/%0d%0aSet-Cookie:x=1");
    expect(odd.status).toBe(308);
    expect(String(odd.headers.location).startsWith("/public-demo/?release=")).toBe(true);
    expect(odd.headers["set-cookie"]).toBeUndefined();
  });

  it("accepts a release from the URL only in the form of a release ID", async () => {
    const html = await (await edge.fetch("/public-demo/")).text();
    // The page's own check is the contract's pattern, so a crafted ?release= value never reaches a URL the page builds.
    expect(html).toContain("const RELEASE_ID = /^[a-z0-9]{1,16}-[0-9a-f]{16}$/;");
    expect(html).toContain("asked && RELEASE_ID.test(asked) ? asked : current.release");
    const pattern = /^[a-z0-9]{1,16}-[0-9a-f]{16}$/;
    expect(pattern.test(a.id)).toBe(true);
    for (const hostile of ["../../private", "a-0123456789abcdef/../x", "a-0123456789abcdef?x", "javascript:alert(1)", "A-0123456789ABCDEF", " a-0123456789abcdef"]) expect(pattern.test(hostile)).toBe(false);
  });

  it("loads hls.js pinned to the version in package-lock.json, with that file's integrity hash", async () => {
    const html = await (await edge.fetch("/public-demo/")).text();
    const tag = /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/hls\.js@([0-9.]+)\/dist\/hls\.light\.min\.js" integrity="(sha384-[A-Za-z0-9+/=]+)" crossorigin="anonymous"><\/script>/.exec(html);
    expect(tag).not.toBeNull();
    const installed = path.join(edgeRoot, "node_modules", "hls.js");
    expect(tag![1]).toBe(JSON.parse(await readFile(path.join(installed, "package.json"), "utf8")).version);
    expect(tag![2]).toBe(`sha384-${createHash("sha384").update(await readFile(path.join(installed, "dist", "hls.light.min.js"))).digest("base64")}`);
  });

  it("shows the thumbnail at rest and plays the preview on hover", async () => {
    const html = await (await edge.fetch("/public-demo/")).text();
    expect(html).toMatch(/<img id="thumbnail"/);
    expect(html).toMatch(/<video id="preview" muted loop playsinline preload="none"/);
    expect(html).toContain('card.addEventListener("pointerenter"');
    expect(html).toContain('card.addEventListener("pointerleave"');
    expect(html).toContain('base + "preview.mp4"');
    expect(html).toContain('base + "thumbnail.jpg"');
  });
});
