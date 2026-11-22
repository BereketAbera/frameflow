/**
 * Checks a published release through the Worker and records what the edge answered: the cache state of a first and a
 * repeat request for every file, at which Cloudflare location, with which headers, and whether the bytes are the
 * published ones. It also probes paths that must not be served.
 *
 *   npm run edge:check -- --origin https://<worker-host> --package .releases/a --label staging [--out .evidence/a]
 *                         [--must-404 /private/canary.txt] [--expect-active <release-id>]
 *
 * It only sends GET requests. Run it right after publishing a release to see a first load: once a file has been
 * requested at a location, later requests there are repeats.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { IMMUTABLE_CACHE_CONTROL, MANIFEST_NAME, parseReleaseManifest, releaseUrlPath } from "../src/shared/contract.js";

const { values } = parseArgs({ options: {
  origin: { type: "string" }, package: { type: "string" }, label: { type: "string", default: "local" }, out: { type: "string" },
  "must-404": { type: "string", multiple: true, default: [] }, "expect-active": { type: "string" },
} });
if (!values.origin || !values.package) { console.error("Usage: npm run edge:check -- --origin <url> --package <dir> [--label staging] [--out <dir>] [--must-404 <path>]... [--expect-active <id>]"); process.exit(2); }
const origin = new URL(values.origin).origin;
const manifest = parseReleaseManifest(await readFile(path.join(values.package, MANIFEST_NAME), "utf8"));

/** Only these response headers are recorded. Nothing that identifies an account, a request or a client. */
const RECORDED = ["content-type", "content-length", "content-encoding", "content-range", "cache-control", "etag", "age", "accept-ranges", "location", "cf-cache-status", "x-frameflow-cache", "x-frameflow-colo", "x-frameflow-release"];
type Observation = { request: string; status: number; headers: Record<string, string>; rayColo: string | null; sha256?: string; bytes?: number };
type Check = { name: string; passed: boolean; detail: string };
const observations: Observation[] = [], checks: Check[] = [];
const check = (name: string, passed: boolean, detail = "") => { checks.push({ name, passed, detail }); if (!passed) console.error(`FAIL  ${name}${detail ? `: ${detail}` : ""}`); };

async function observe(target: string, headers: Record<string, string> = {}, note = ""): Promise<Observation & { body: Uint8Array }> {
  const response = await fetch(`${origin}${target}`, { headers, redirect: "manual" });
  const body = new Uint8Array(await response.arrayBuffer());
  // cf-ray is "<request id>-<location>". Only the location is kept.
  const ray = response.headers.get("cf-ray"), recorded: Record<string, string> = {};
  for (const name of RECORDED) { const value = response.headers.get(name); if (value !== null) recorded[name] = value; }
  const range = headers.range ? ` (Range: ${headers.range})` : "";
  const observation = { request: `GET ${target}${range}${note ? ` [${note}]` : ""}`, status: response.status, headers: recorded, rayColo: ray ? ray.slice(ray.lastIndexOf("-") + 1) : null, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
  observations.push(observation);
  return { ...observation, body };
}
const colo = (observation: Observation) => observation.headers["x-frameflow-colo"] ?? observation.rayColo ?? "unknown";
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// 1. The active reference: answered fresh every time, never from a cache.
const active: string[] = [];
for (const attempt of [1, 2]) {
  const current = await observe("/public-demo/current.json", {}, `request ${attempt}`);
  check(`current.json request ${attempt} is not cacheable and not from a cache`, current.status === 200 && current.headers["cache-control"] === "no-store" && current.headers["cf-cache-status"] === undefined && current.headers["x-frameflow-cache"] === "BYPASS", `status ${current.status}, cache-control ${current.headers["cache-control"]}, cf-cache-status ${current.headers["cf-cache-status"] ?? "absent"}`);
  if (current.status === 200) active.push((JSON.parse(new TextDecoder().decode(current.body)) as { release: string }).release);
}
if (values["expect-active"]) check(`the active release is ${values["expect-active"]}`, active.length === 2 && active.every((release) => release === values["expect-active"]), `saw ${active.join(", ") || "none"}`);
const redirect = await observe("/public-demo/current.m3u8");
check("current.m3u8 redirects to the active master playlist without being stored", redirect.status === 302 && redirect.headers["cache-control"] === "no-store" && redirect.headers.location === `/public-demo/releases/${active[0]}/master.m3u8`, `status ${redirect.status}, location ${redirect.headers.location}`);

// 2. Every file of the release: a first request, a repeat at the same location, and a range from the middle.
const summary: Array<{ file: string; first: string; repeat: string; location: string; sameLocation: boolean }> = [];
for (const file of manifest.files) {
  const target = releaseUrlPath(manifest.id, file.path);
  const first = await observe(target, {}, "first");
  // Cloudflare compresses text such as playlists on the way out, for a client that accepts it. Such a response has no
  // Content-Length of the file's own size, so the length is checked on the header only when the body was sent as it is,
  // and always on the decoded bytes.
  const sentAsIs = first.headers["content-encoding"] === undefined;
  check(`${file.path}: served complete and correct`, first.status === 200 && first.sha256 === file.sha256 && first.bytes === file.size && (!sentAsIs || first.headers["content-length"] === String(file.size)), `status ${first.status}, ${first.bytes} bytes, content-length ${first.headers["content-length"] ?? "absent"}, content-encoding ${first.headers["content-encoding"] ?? "none"}`);
  check(`${file.path}: ${file.contentType}, immutable for a year`, first.headers["content-type"] === file.contentType && first.headers["cache-control"] === IMMUTABLE_CACHE_CONTROL, `${first.headers["content-type"]}; ${first.headers["cache-control"]}`);

  // The cache is filled just after the first response completes, and the next request may land on another location, so the repeat is retried briefly.
  let repeat = await observe(target, {}, "repeat");
  for (let attempt = 0; attempt < 20 && !(repeat.headers["x-frameflow-cache"] === "HIT" && colo(repeat) === colo(first)); attempt++) { await pause(250); repeat = await observe(target, {}, "repeat"); }
  const sameLocation = colo(repeat) === colo(first);
  check(`${file.path}: the repeat request is a cache HIT at the same location with the same bytes`, repeat.headers["x-frameflow-cache"] === "HIT" && sameLocation && repeat.sha256 === file.sha256, `first ${first.headers["x-frameflow-cache"]} at ${colo(first)}, repeat ${repeat.headers["x-frameflow-cache"]} at ${colo(repeat)}`);
  summary.push({ file: file.path, first: first.headers["x-frameflow-cache"] ?? "?", repeat: repeat.headers["x-frameflow-cache"] ?? "?", location: colo(first), sameLocation });

  const start = Math.floor(file.size / 2), end = Math.min(start + 99, file.size - 1);
  const ranged = await observe(target, { range: `bytes=${start}-${end}` });
  const expected = createHash("sha256").update(first.body.subarray(start, end + 1)).digest("hex");
  check(`${file.path}: a range is answered as 206 with exactly those bytes`, ranged.status === 206 && ranged.headers["content-range"] === `bytes ${start}-${end}/${file.size}` && ranged.sha256 === expected, `status ${ranged.status}, content-range ${ranged.headers["content-range"]}`);
  // After a ranged request, the whole URL must still be the whole object.
  const whole = await observe(target, {}, "after the range");
  check(`${file.path}: still the complete object after a ranged request`, whole.status === 200 && whole.sha256 === file.sha256, `${whole.bytes} bytes`);
}

// 3. What must not be served: the publisher's own objects, anything unlisted, and anything outside the public path.
const forbidden = [
  "/", "/private/canary.txt", "/videos/canary/source/source.mp4", "/public-demo/active.json", `/public-demo/releases/${manifest.id}/release.json`,
  `/public-demo/releases/${manifest.id}/source.mp4`, `/public-demo/releases/${manifest.id}/720p/segment-999.ts`, `/public-demo/releases/${manifest.id}/unlisted-canary.ts`,
  `/public-demo/releases/${manifest.id}/%2e%2e/%2e%2e/%2e%2e/private/canary.txt`, `/public-demo/releases/${manifest.id}/master.m3u8?v=2`, "/public-demo/releases/zz-0000000000000000/master.m3u8",
  ...values["must-404"],
];
for (const target of forbidden) {
  const response = await observe(target, {}, "must not be served");
  check(`${target} is not served`, response.status === 404 && response.headers["cache-control"] === "no-store" && !new TextDecoder().decode(response.body).includes("canary"), `status ${response.status}`);
}

const failed = checks.filter((entry) => !entry.passed), locations = [...new Set(observations.map(colo))];
const report = { label: values.label, checkedAt: new Date().toISOString(), release: manifest.id, activeRelease: active[0] ?? null, locations, passed: checks.length - failed.length, failed: failed.length, summary, checks, observations };
const table = ["| File | First request | Repeat request | Location | Same location |", "| --- | --- | --- | --- | --- |", ...summary.map((row) => `| \`${row.file}\` | ${row.first} | ${row.repeat} | ${row.location} | ${row.sameLocation ? "yes" : "no"} |`)].join("\n");
const headersOf = (observation: Observation) => [`${observation.request}`, `HTTP ${observation.status}`, ...Object.entries(observation.headers).map(([name, value]) => `${name}: ${value}`), ...(observation.rayColo ? [`cf-ray: <redacted>-${observation.rayColo}`] : [])].join("\n");
const sample = manifest.files.find((file) => file.path.endsWith(".ts")) ?? manifest.files[0]!, sampleTarget = releaseUrlPath(manifest.id, sample.path);
const markdown = `# Edge check: ${values.label}

Release \`${manifest.id}\`, checked ${report.checkedAt} at ${locations.join(", ")}. ${report.passed} of ${checks.length} checks passed.
The origin is left out on purpose. Headers are limited to the ones listed in \`scripts/edge-check.ts\`.

${table}

## Headers for \`${sample.path}\`

\`\`\`text
${observations.filter((observation) => observation.request.startsWith(`GET ${sampleTarget}`)).slice(0, 3).map(headersOf).join("\n\n")}
\`\`\`

## Headers for the active reference

\`\`\`text
${observations.filter((observation) => observation.request.startsWith("GET /public-demo/current")).map(headersOf).join("\n\n")}
\`\`\`
${failed.length ? `\n## Failed checks\n\n${failed.map((entry) => `- ${entry.name}: ${entry.detail}`).join("\n")}\n` : ""}`;

if (values.out) {
  await mkdir(values.out, { recursive: true });
  await writeFile(path.join(values.out, "edge-check.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(values.out, "edge-check.md"), markdown);
}
console.log(`${table}\n\n${report.passed} of ${checks.length} checks passed for ${manifest.id} at ${locations.join(", ")} (${values.label}).${values.out ? ` Evidence written to ${values.out}.` : ""}`);
process.exitCode = failed.length ? 1 : 0;
