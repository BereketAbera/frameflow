import { describe, expect, it } from "vitest";
import {
  ContractError, classifyReleaseFile, computeReleaseId, isReleaseId, parseActiveReference, parseReleaseManifest, releaseObjectKey, releaseUrlPath,
  serializeActiveReference, serializeReleaseManifest, type ReleaseManifest,
} from "../src/shared/contract.js";

const file = (path: string, contentType: string, fill: string) => ({ path, size: 188, sha256: fill.repeat(64), md5: fill.repeat(32), contentType });
const files = [
  file("360p/index.m3u8", "application/vnd.apple.mpegurl", "1"), file("360p/segment-000.ts", "video/mp2t", "2"),
  file("master.m3u8", "application/vnd.apple.mpegurl", "3"), file("preview.mp4", "video/mp4", "4"), file("thumbnail.jpg", "image/jpeg", "5"),
];
async function manifest(): Promise<ReleaseManifest> {
  return {
    schemaVersion: 1, id: await computeReleaseId("a", files), label: "a", durationSeconds: 6, master: "master.m3u8", thumbnail: "thumbnail.jpg", preview: "preview.mp4",
    renditions: [{ name: "360p", playlist: "360p/index.m3u8", width: 640, height: 360, bandwidth: 985_600, segments: 1 }], files,
  };
}
const withChange = async (change: (value: Record<string, any>) => void): Promise<string> => { const value = JSON.parse(serializeReleaseManifest(await manifest())); change(value); return JSON.stringify(value); };

describe("the files a release may hold", () => {
  it("accepts exactly the pipeline's playlists and segments, a thumbnail and a preview", () => {
    expect(classifyReleaseFile("master.m3u8")).toEqual({ kind: "master", contentType: "application/vnd.apple.mpegurl" });
    expect(classifyReleaseFile("720p/index.m3u8")?.kind).toBe("playlist");
    expect(classifyReleaseFile("1080p/segment-0123.ts")).toEqual({ kind: "segment", contentType: "video/mp2t" });
    expect(classifyReleaseFile("thumbnail.jpg")?.contentType).toBe("image/jpeg");
    expect(classifyReleaseFile("preview.mp4")?.contentType).toBe("video/mp4");
  });

  it.each([
    "release.json", "source.mp4", "source/source.mp4", "720p/source.mp4", "720p/segment-000.mp4", "720p/segment-00.ts", "720p/../master.m3u8", "../master.m3u8",
    "/master.m3u8", "720p//index.m3u8", "720P/index.m3u8", "master.m3u8/", "master.m3u8?x=1", "thumbnail.jpg.exe", "720p/index.m3u8\n", "%2e%2e/master.m3u8", "",
  ])("rejects %j", (path) => { expect(classifyReleaseFile(path)).toBeNull(); });

  it("maps a release file to one key and one URL path, both under the public prefix", () => {
    expect(releaseObjectKey("a-0123456789abcdef", "720p/segment-000.ts")).toBe("public-demo/releases/a-0123456789abcdef/720p/segment-000.ts");
    expect(releaseUrlPath("a-0123456789abcdef", "master.m3u8")).toBe("/public-demo/releases/a-0123456789abcdef/master.m3u8");
  });
});

describe("release IDs", () => {
  it("derive from the content, so changed content can never claim an existing version path", async () => {
    const id = await computeReleaseId("a", files);
    expect(isReleaseId(id)).toBe(true);
    expect(await computeReleaseId("a", [...files].reverse())).toBe(id);
    expect(await computeReleaseId("a", files.map((entry, index) => (index === 1 ? { ...entry, sha256: "9".repeat(64) } : entry)))).not.toBe(id);
    expect(await computeReleaseId("a", files.map((entry, index) => (index === 1 ? { ...entry, size: 376 } : entry)))).not.toBe(id);
    expect(await computeReleaseId("b", files)).toBe(`b-${id.slice(2)}`);
  });

  it.each(["a", "a-123", "A-0123456789abcdef", "a-0123456789ABCDEF", "a_b-0123456789abcdef", "../a-0123456789abcdef", "a-0123456789abcdef/", ""])("does not accept %j as an ID", (value) => { expect(isReleaseId(value)).toBe(false); });
});

describe("the release manifest", () => {
  it("round-trips through its one canonical form", async () => {
    const original = await manifest(), text = serializeReleaseManifest(original);
    expect(parseReleaseManifest(text)).toEqual(original);
    expect(serializeReleaseManifest(parseReleaseManifest(text))).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it.each<[string, (value: Record<string, any>) => void]>([
    ["an unknown field", (value) => { value.note = "x"; }],
    ["a missing field", (value) => { delete value.preview; }],
    ["another schema version", (value) => { value.schemaVersion = 2; }],
    ["an ID that does not carry its label", (value) => { value.label = "b"; }],
    ["a file outside the allowed set", (value) => { value.files.push(file("source.mp4", "video/mp4", "6")); }],
    ["a wrong content type", (value) => { value.files[1].contentType = "text/html"; }],
    ["unsorted files", (value) => { value.files.reverse(); }],
    ["a duplicate file", (value) => { value.files.splice(1, 0, value.files[0]); }],
    ["a malformed checksum", (value) => { value.files[0].sha256 = "xyz"; }],
    ["an empty file", (value) => { value.files[0].size = 0; }],
    ["no thumbnail", (value) => { value.files = value.files.filter((entry: { path: string }) => entry.path !== "thumbnail.jpg"); }],
    ["no preview", (value) => { value.files = value.files.filter((entry: { path: string }) => entry.path !== "preview.mp4"); }],
    ["a rendition without its playlist", (value) => { value.files = value.files.filter((entry: { path: string }) => entry.path !== "360p/index.m3u8"); }],
    ["a wrong segment count", (value) => { value.renditions[0].segments = 2; }],
    ["a segment of an unlisted rendition", (value) => { value.files.splice(2, 0, file("720p/segment-000.ts", "video/mp2t", "7")); }],
    ["no renditions", (value) => { value.renditions = []; }],
  ])("rejects %s", async (_name, change) => { expect(() => parseReleaseManifest("")).toThrow(ContractError); const text = await withChange(change); expect(() => parseReleaseManifest(text)).toThrow(ContractError); });
});

describe("the active reference", () => {
  const reference = { schemaVersion: 1 as const, activeRelease: "b-0123456789abcdef", previousRelease: "a-0123456789abcdef", sequence: 2, updatedAt: "2026-11-22T18:00:00.000Z" };

  it("round-trips", () => { expect(parseActiveReference(serializeActiveReference(reference))).toEqual(reference); });
  it("allows no previous release", () => { expect(parseActiveReference(serializeActiveReference({ ...reference, previousRelease: null })).previousRelease).toBeNull(); });
  it.each([
    { ...reference, activeRelease: "../secret" }, { ...reference, previousRelease: "nope" }, { ...reference, sequence: 0 }, { ...reference, updatedAt: "yesterday" },
    { ...reference, schemaVersion: 2 }, { ...reference, extra: true },
  ])("rejects %j", (value) => { expect(() => parseActiveReference(JSON.stringify(value))).toThrow(ContractError); });
  it("rejects text that is not a JSON object", () => { for (const text of ["", "null", "[]", "\"a\""]) expect(() => parseActiveReference(text)).toThrow(ContractError); });
});
