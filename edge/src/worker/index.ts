/**
 * The public demo Worker. It answers for one path prefix, /public-demo/, from one dedicated R2 bucket, and it only
 * reads. Three kinds of thing are reachable:
 *
 *   /public-demo/                              the demo player page
 *   /public-demo/current.json | current.m3u8   the active release, resolved from the bucket on every request
 *   /public-demo/releases/<id>/<file>          immutable release files, cached at the edge
 *
 * A release file is served only when a published manifest lists it. Nothing else in the bucket is reachable, and the
 * Worker has no binding to Frameflow's private storage at all.
 */
import {
  ACTIVE_REFERENCE_KEY, IMMUTABLE_CACHE_CONTROL, JSON_CONTENT_TYPE, MANIFEST_NAME, MAX_MANIFEST_BYTES, NO_STORE, PUBLIC_PREFIX,
  classifyReleaseFile, computeReleaseId, isReleaseId, parseActiveReference, parseReleaseManifest, releaseObjectKey, releaseUrlPath, toHex,
  type ActiveReference, type ReleaseFile, type ReleaseManifest,
} from "../shared/contract";
import { playerPage } from "./player-page";

export interface Env {
  /** The dedicated public demo bucket. The only storage this Worker can reach. */
  PUBLIC_DEMO: R2Bucket;
  ENVIRONMENT?: string;
  /** Part of every edge cache key. Raising it abandons everything cached so far, which a rollback never needs. */
  CACHE_EPOCH?: string;
}

type CacheState = "HIT" | "MISS" | "BYPASS";

const ROOT = `/${PUBLIC_PREFIX}/`;
const RELEASE_ROUTE = new RegExp(`^/${PUBLIC_PREFIX}/releases/([^/]+)/(.+)$`);
const EXPOSED_HEADERS = "content-length, content-range, etag, x-frameflow-cache, x-frameflow-colo, x-frameflow-release";
/** Set only on the copy kept in the edge cache: the object's size. It is removed before anything is sent to a viewer. */
const STORED_SIZE = "x-frameflow-size";
/** The sample is public and carries no credentials, so any origin may embed and read it. */
const PUBLIC_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": EXPOSED_HEADERS,
  "cross-origin-resource-policy": "cross-origin",
  "timing-allow-origin": "*",
  "x-content-type-options": "nosniff",
};

/** Manifests are immutable once written, so a found one can be kept for the life of the isolate. A missing one is never remembered. */
const manifests = new Map<string, ReleaseManifest>();
const MAX_REMEMBERED_MANIFESTS = 16;
/**
 * When a background cache fill was last started in this isolate, by cache key, so a burst of ranged requests starts
 * one fill and not many. Only timestamps are kept: a promise must not be shared between requests.
 */
const fills = new Map<string, number>();
const FILL_WINDOW_MS = 30_000;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const colo = typeof request.cf?.colo === "string" ? request.cf.colo : "unknown";
    try {
      return await route(request, env, ctx, colo);
    } catch (error) {
      console.error(JSON.stringify({ event: "unhandled", message: error instanceof Error ? error.message : String(error) }));
      return plain(500, "Internal error", colo);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext, colo: string): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  if (path !== `/${PUBLIC_PREFIX}` && !path.startsWith(ROOT)) return plain(404, "Not found", colo);
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed", colo, { allow: "GET, HEAD, OPTIONS" });

  // The page reads ?release=<id>, so the redirect to its canonical URL carries the query along.
  if (path === `/${PUBLIC_PREFIX}`) return new Response(null, { status: 308, headers: { location: `${ROOT}${url.search}`, "cache-control": NO_STORE } });
  if (path === ROOT) return finish(await playerPage(env.ENVIRONMENT ?? "staging"), "BYPASS", colo, request);
  // Only the page reads a query string. Anywhere else it could only serve to mint new cache keys.
  if (url.search !== "") return plain(404, "Not found", colo);
  if (path === `${ROOT}current.json`) return currentJson(request, env, colo);
  if (path === `${ROOT}current.m3u8`) return currentPlaylist(request, env, colo);
  const release = RELEASE_ROUTE.exec(path);
  if (release) return releaseFile(request, env, ctx, colo, release[1]!, release[2]!);
  return plain(404, "Not found", colo);
}

/** Adds the per-request diagnostics. They are never part of what the edge cache stores. */
function finish(response: Response, cache: CacheState, colo: string, request: Request, releaseId?: string): Response {
  const result = new Response(request.method === "HEAD" ? null : response.body, response);
  if (request.method === "HEAD" && response.body) void response.body.cancel();
  result.headers.set("x-frameflow-cache", cache);
  result.headers.set("x-frameflow-colo", colo);
  if (releaseId) result.headers.set("x-frameflow-release", releaseId);
  return result;
}

/** Every answer that is not an immutable release file says no-store explicitly, so nothing downstream caches it by guesswork. */
function plain(status: number, message: string, colo: string, headers: Record<string, string> = {}): Response {
  return new Response(`${message}\n`, { status, headers: { ...PUBLIC_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": NO_STORE, "x-frameflow-cache": "BYPASS", "x-frameflow-colo": colo, ...headers } });
}

function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...PUBLIC_HEADERS, "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-allow-headers": "range, if-none-match, if-range", "access-control-max-age": "86400", "cache-control": NO_STORE } });
}

async function loadManifest(env: Env, releaseId: string): Promise<ReleaseManifest | null> {
  const remembered = manifests.get(releaseId);
  if (remembered) return remembered;
  const object = await env.PUBLIC_DEMO.get(releaseObjectKey(releaseId, MANIFEST_NAME));
  if (!object) return null;
  try {
    if (object.size > MAX_MANIFEST_BYTES) throw new Error("the manifest is too large");
    const manifest = parseReleaseManifest(await object.text());
    // The ID in the URL must be the one the listed content produces, so a manifest cannot vouch for another release's path.
    if (manifest.id !== releaseId || (await computeReleaseId(manifest.label, manifest.files)) !== releaseId) throw new Error("the manifest describes another release");
    if (manifests.size >= MAX_REMEMBERED_MANIFESTS) manifests.delete(manifests.keys().next().value!);
    manifests.set(releaseId, manifest);
    return manifest;
  } catch (error) {
    console.error(JSON.stringify({ event: "invalid-manifest", release: releaseId, message: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

/** Reads the active reference straight from the bucket. It is never put in a cache, here or downstream. */
async function loadActive(env: Env): Promise<{ reference: ActiveReference; manifest: ReleaseManifest } | null> {
  const object = await env.PUBLIC_DEMO.get(ACTIVE_REFERENCE_KEY);
  if (!object) return null;
  let reference: ActiveReference;
  try { reference = parseActiveReference(await object.text()); }
  catch (error) { console.error(JSON.stringify({ event: "invalid-active-reference", message: error instanceof Error ? error.message : String(error) })); return null; }
  const manifest = await loadManifest(env, reference.activeRelease);
  if (!manifest) { console.error(JSON.stringify({ event: "active-release-not-servable", release: reference.activeRelease })); return null; }
  return { reference, manifest };
}

async function currentJson(request: Request, env: Env, colo: string): Promise<Response> {
  const active = await loadActive(env);
  if (!active) return finish(Response.json({ error: "no_active_release" }, { status: 404, headers: { ...PUBLIC_HEADERS, "cache-control": NO_STORE } }), "BYPASS", colo, request);
  const { reference, manifest } = active, id = manifest.id;
  const body = {
    release: id, sequence: reference.sequence, updatedAt: reference.updatedAt, durationSeconds: manifest.durationSeconds,
    playlist: releaseUrlPath(id, manifest.master), thumbnail: releaseUrlPath(id, manifest.thumbnail), preview: releaseUrlPath(id, manifest.preview),
    renditions: manifest.renditions.map(({ name, width, height, bandwidth }) => ({ name, width, height, bandwidth })),
  };
  return finish(new Response(`${JSON.stringify(body, null, 2)}\n`, { headers: { ...PUBLIC_HEADERS, "content-type": JSON_CONTENT_TYPE, "cache-control": NO_STORE } }), "BYPASS", colo, request, id);
}

/** One stable URL any HLS player can open. The redirect is not stored, and what it points at never changes. */
async function currentPlaylist(request: Request, env: Env, colo: string): Promise<Response> {
  const active = await loadActive(env);
  if (!active) return plain(404, "No release is active", colo);
  return finish(new Response(null, { status: 302, headers: { ...PUBLIC_HEADERS, location: releaseUrlPath(active.manifest.id, active.manifest.master), "cache-control": NO_STORE } }), "BYPASS", colo, request, active.manifest.id);
}

function releaseHeaders(file: ReleaseFile, releaseId: string): Headers {
  return new Headers({
    ...PUBLIC_HEADERS, "content-type": file.contentType, "cache-control": IMMUTABLE_CACHE_CONTROL, etag: `"${file.sha256}"`,
    "accept-ranges": "bytes", "x-frameflow-release": releaseId,
  });
}

type ByteRange = { start: number; end: number; length: number };

/** One `bytes=` range, or null to serve the whole object, which HTTP always allows when a Range header is ignored. */
function parseRange(header: string, size: number): ByteRange | "unsatisfiable" | null {
  const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1, length };
  }
  const start = Number(match[1]);
  if (start >= size) return "unsatisfiable";
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return end < start ? null : { start, end, length: end - start + 1 };
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.trim() === "*" || header.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === etag);
}

type Decision = { kind: "not-modified" } | { kind: "head" } | { kind: "unsatisfiable" } | { kind: "whole" } | { kind: "range"; range: ByteRange };

/**
 * What a request for a release file gets, from the request and the object's size and ETag alone. The cache-hit path
 * and the bucket path both ask this one function, so they cannot disagree about a range, a HEAD or a revalidation,
 * and the cache is never handed a Range header to interpret on its own.
 */
function decide(request: Request, size: number, etag: string): Decision {
  if (etagMatches(request.headers.get("if-none-match"), etag)) return { kind: "not-modified" };
  if (request.method === "HEAD") return { kind: "head" };
  const header = request.headers.get("range");
  if (header === null) return { kind: "whole" };
  // If-Range: the range applies only while the viewer's copy is this exact object. Otherwise they get all of it.
  const ifRange = request.headers.get("if-range");
  if (ifRange !== null && ifRange.trim() !== etag) return { kind: "whole" };
  const range = parseRange(header, size);
  return range === null ? { kind: "whole" } : range === "unsatisfiable" ? { kind: "unsatisfiable" } : { kind: "range", range };
}

const notModified = (headers: Headers): Response => new Response(null, { status: 304, headers });
const headOnly = (headers: Headers, size: number): Response => { headers.set("content-length", String(size)); return new Response(null, { status: 200, headers }); };
/** FixedLengthStream gives the response its Content-Length and fails it unless exactly that many bytes pass. */
const whole = (headers: Headers, size: number, body: ReadableStream<Uint8Array>): Response => new Response(body.pipeThrough(new FixedLengthStream(size)), { status: 200, headers });
const partial = (headers: Headers, size: number, range: ByteRange, body: ReadableStream<Uint8Array>): Response => {
  headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
  return new Response(body.pipeThrough(new FixedLengthStream(range.length)), { status: 206, headers });
};
const unsatisfiable = (size: number, colo: string): Response => plain(416, "Range not satisfiable", colo, { "content-range": `bytes */${size}` });

/** Cuts a byte range out of a stream of the whole object, and stops reading as soon as it has it. */
function slice(body: ReadableStream<Uint8Array>, range: ByteRange): ReadableStream<Uint8Array> {
  let skip = range.start, remaining = range.length;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (skip >= chunk.byteLength) { skip -= chunk.byteLength; return; }
      const piece = chunk.subarray(skip, skip + remaining);
      skip = 0;
      remaining -= piece.byteLength;
      controller.enqueue(piece);
      if (remaining === 0) controller.terminate();
    },
  }));
}

/** An object is served only if it is, by size and by the bucket's own MD5, the object the manifest was published with. */
function integrityProblem(object: R2Object | null, file: ReleaseFile): string | null {
  if (!object) return "missing from the bucket";
  if (object.size !== file.size) return `${object.size} bytes in the bucket, ${file.size} in the manifest`;
  if (!object.checksums.md5) return "stored without an MD5 checksum";
  return toHex(object.checksums.md5) === file.md5 ? null : "MD5 differs from the manifest";
}

function unavailable(releaseId: string, path: string, problem: string, colo: string): Response {
  console.error(JSON.stringify({ event: "release-object-unavailable", release: releaseId, path, problem }));
  return plain(502, "This release file is unavailable", colo);
}

const cacheKeyFor = (origin: string, env: Env, releaseId: string, path: string): string => `${origin}${releaseUrlPath(releaseId, path)}?epoch=${encodeURIComponent(env.CACHE_EPOCH ?? "1")}`;

/**
 * Stores the complete object in this location's cache. FixedLengthStream is the guard that matters: the cache would
 * otherwise keep whatever bytes arrived before a stream ended, as a full 200, for a year. With it, a body that is not
 * exactly the manifest's length fails the put and nothing is stored.
 */
function storeInCache(cacheKey: string, body: ReadableStream<Uint8Array>, file: ReleaseFile, releaseId: string): Promise<void> {
  const headers = releaseHeaders(file, releaseId);
  // The size travels with the stored object in a header of its own, so reading it back does not depend on how a cache reports Content-Length.
  headers.set(STORED_SIZE, String(file.size));
  const response = new Response(body.pipeThrough(new FixedLengthStream(file.size)), { status: 200, headers });
  return caches.default.put(new Request(cacheKey), response).catch((error: unknown) => {
    console.error(JSON.stringify({ event: "cache-put-failed", release: releaseId, path: file.path, message: error instanceof Error ? error.message : String(error) }));
  });
}

/** After a ranged miss: fetch the whole object once, in the background, so the next request here is a hit. */
async function fillCache(env: Env, cacheKey: string, file: ReleaseFile, releaseId: string): Promise<void> {
  const started = fills.get(cacheKey), now = Date.now();
  if (started !== undefined && now - started < FILL_WINDOW_MS) return;
  if (fills.size >= 256) fills.clear();
  fills.set(cacheKey, now);
  try {
    const object = await env.PUBLIC_DEMO.get(releaseObjectKey(releaseId, file.path));
    if (object && !integrityProblem(object, file)) await storeInCache(cacheKey, object.body, file, releaseId);
    else if (object) await object.body.cancel();
  } catch (error) {
    console.error(JSON.stringify({ event: "cache-fill-failed", release: releaseId, path: file.path, message: error instanceof Error ? error.message : String(error) }));
  } finally {
    fills.delete(cacheKey);
  }
}

async function releaseFile(request: Request, env: Env, ctx: ExecutionContext, colo: string, releaseId: string, path: string): Promise<Response> {
  if (!isReleaseId(releaseId) || !classifyReleaseFile(path)) return plain(404, "Not found", colo);
  const cacheKey = cacheKeyFor(new URL(request.url).origin, env, releaseId, path);
  const log = (status: number, cache: CacheState) => console.log(JSON.stringify({ event: "release-file", release: releaseId, path, method: request.method, range: request.headers.get("range"), status, cache, colo }));
  const done = (response: Response, cache: CacheState) => { log(response.status, cache); return finish(response, cache, colo, request, releaseId); };

  // 1. This location's cache. It only ever holds complete objects, and it is only ever asked for one: the lookup
  //    carries no Range and no validators. What the viewer gets out of that object is decided here, not by the cache.
  const cached = await caches.default.match(new Request(cacheKey));
  if (cached) {
    const size = Number(cached.headers.get(STORED_SIZE)), etag = cached.headers.get("etag"), body = cached.body;
    if (cached.status === 200 && body && etag && Number.isSafeInteger(size) && size > 0) {
      const headers = new Headers(cached.headers);
      headers.delete(STORED_SIZE);
      headers.delete("content-length");
      const decision = decide(request, size, etag);
      if (decision.kind === "whole") return done(whole(headers, size, body), "HIT");
      if (decision.kind === "range") return done(partial(headers, size, decision.range, slice(body, decision.range)), "HIT");
      await body.cancel();
      if (decision.kind === "not-modified") return done(notModified(headers), "HIT");
      if (decision.kind === "head") return done(headOnly(headers, size), "HIT");
      return unsatisfiable(size, colo);
    }
    // Not something this Worker stored. Leave it and answer from the bucket.
    await body?.cancel();
  }

  // 2. A miss. Before the bucket is read, the file must be listed by the manifest of a complete release.
  const manifest = await loadManifest(env, releaseId), file = manifest?.files.find((candidate) => candidate.path === path);
  if (!file) return plain(404, "Not found", colo);
  const headers = releaseHeaders(file, releaseId), key = releaseObjectKey(releaseId, path), decision = decide(request, file.size, `"${file.sha256}"`);
  if (decision.kind === "not-modified") return done(notModified(headers), "MISS");
  if (decision.kind === "unsatisfiable") return unsatisfiable(file.size, colo);

  if (decision.kind === "head") {
    const problem = integrityProblem(await env.PUBLIC_DEMO.head(key), file);
    return problem ? unavailable(releaseId, path, problem, colo) : done(headOnly(headers, file.size), "MISS");
  }

  if (decision.kind === "range") {
    // 3a. A ranged miss is answered straight from the bucket as 206 and is never stored. The cache is filled separately, with the whole object.
    const object = await env.PUBLIC_DEMO.get(key, { range: { offset: decision.range.start, length: decision.range.length } });
    const problem = integrityProblem(object, file);
    if (!object || problem) return unavailable(releaseId, path, problem ?? "missing from the bucket", colo);
    ctx.waitUntil(fillCache(env, cacheKey, file, releaseId));
    return done(partial(headers, file.size, decision.range, object.body), "MISS");
  }

  // 3b. A full miss: one read from the bucket, sent to the viewer and stored in this location's cache at the same time.
  const object = await env.PUBLIC_DEMO.get(key);
  const problem = integrityProblem(object, file);
  if (!object || problem) return unavailable(releaseId, path, problem ?? "missing from the bucket", colo);
  const [forViewer, forCache] = object.body.tee();
  ctx.waitUntil(storeInCache(cacheKey, forCache, file, releaseId));
  return done(whole(headers, file.size, forViewer), "MISS");
}
