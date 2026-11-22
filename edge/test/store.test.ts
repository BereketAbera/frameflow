/** The publisher's two conditional writes, over the S3 API of the local runtime's R2 bucket, and the guards around them. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3ReleaseStore, assertPublicKey, loadStoreConfig } from "../src/publisher/store.js";
import { startLocalEdge, type LocalEdge } from "../local/runtime.js";

let edge: LocalEdge;
beforeAll(async () => { edge = await startLocalEdge(); });
afterAll(async () => { await edge.dispose(); });

const text = (value: string) => new TextEncoder().encode(value);
const put = (key: string, body: string) => ({ key, body: text(body), contentType: "application/json; charset=utf-8", cacheControl: "no-store" });

describe("create-only writes", () => {
  it("create an object once and never replace it", async () => {
    const key = "public-demo/releases/a-0000000000000001/master.m3u8";
    const first = await edge.store.createOnly(put(key, "first"));
    expect(first).toMatchObject({ created: true, etag: expect.stringMatching(/^"[0-9a-f]{32}"$/) });
    expect(await edge.store.createOnly(put(key, "second"))).toEqual({ created: false });
    expect(await edge.store.createOnly(put(key, "first"))).toEqual({ created: false });
    const stored = await edge.store.get(key);
    expect(new TextDecoder().decode(stored!.body)).toBe("first");
    expect(stored).toMatchObject({ contentType: "application/json; charset=utf-8", cacheControl: "no-store", size: 5 });
  });

  it("let exactly one of many concurrent writers win", async () => {
    const key = "public-demo/releases/a-0000000000000002/master.m3u8";
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => edge.store.createOnly(put(key, `writer ${index}`))));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const winner = results.findIndex((result) => result.created);
    expect(new TextDecoder().decode((await edge.store.get(key))!.body)).toBe(`writer ${winner}`);
  });
});

describe("compare-and-swap writes", () => {
  const key = "public-demo/active.json";

  it("replace an object only for the writer that saw its current version", async () => {
    const created = await edge.store.createOnly(put(key, "v1"));
    if (!created.created) throw new Error("expected to create the object");
    expect(await edge.store.replaceIfMatch({ ...put(key, "stale"), ifMatch: '"00000000000000000000000000000000"' })).toEqual({ replaced: false });
    const second = await edge.store.replaceIfMatch({ ...put(key, "v2"), ifMatch: created.etag });
    expect(second.replaced).toBe(true);
    // The first ETag is spent: whoever still holds it lost.
    expect(await edge.store.replaceIfMatch({ ...put(key, "late"), ifMatch: created.etag })).toEqual({ replaced: false });
    expect(new TextDecoder().decode((await edge.store.get(key))!.body)).toBe("v2");
  });

  it("let exactly one of many writers holding the same version win", async () => {
    const current = (await edge.store.head(key))!;
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => edge.store.replaceIfMatch({ ...put(key, `racer ${index}`), ifMatch: current.etag })));
    expect(results.filter((result) => result.replaced)).toHaveLength(1);
  });

  it.each(["", "   ", "0123456789abcdef0123456789abcdef", "W/\"abc\"", "*"])("refuse the unusable ETag %j instead of sending a write without its condition", async (ifMatch) => {
    const before = await edge.store.get(key);
    await expect(edge.store.replaceIfMatch({ ...put(key, "unconditional"), ifMatch })).rejects.toThrow(/no usable ETag/);
    expect(await edge.store.get(key)).toEqual(before);
  });

  it("do not create an object that is not there", async () => {
    expect(await edge.store.replaceIfMatch({ ...put("public-demo/absent.json", "x"), ifMatch: '"00000000000000000000000000000000"' })).toEqual({ replaced: false });
    expect(await edge.store.head("public-demo/absent.json")).toBeNull();
  });
});

describe("reads", () => {
  it("report a missing object as null and list by prefix", async () => {
    expect(await edge.store.get("public-demo/releases/zz-0000000000000000/master.m3u8")).toBeNull();
    expect(await edge.store.head("public-demo/releases/zz-0000000000000000/master.m3u8")).toBeNull();
    expect((await edge.store.list("public-demo/releases/a-0000000000000001/")).map((object) => object.key)).toEqual(["public-demo/releases/a-0000000000000001/master.m3u8"]);
    expect(await edge.store.list("public-demo/releases/zz-0000000000000000/")).toEqual([]);
  });

  it("list more objects than one page holds", async () => {
    const prefix = "public-demo/releases/a-0000000000000003/";
    await Promise.all(Array.from({ length: 1005 }, (_, index) => edge.bucket.put(`${prefix}360p/segment-${String(index).padStart(4, "0")}.ts`, "x")));
    expect(await edge.store.list(prefix)).toHaveLength(1005);
  }, 120_000);
});

describe("the publisher cannot reach outside the public prefix", () => {
  const outside = ["private/owner-notes.txt", "videos/abc/source/source.mp4", "public-demo", "public-demox/a", "/public-demo/a", "public-demo/../private/a", "public-demo//a", "public-demo/a\\b", "public-demo/a\nb", ""];

  it.each(outside)("refuses the key %j before any request is sent", async (key) => {
    expect(() => assertPublicKey(key)).toThrow(/Refusing to touch/);
    await expect(edge.store.createOnly(put(key, "x"))).rejects.toThrow(/Refusing to touch/);
    await expect(edge.store.replaceIfMatch({ ...put(key, "x"), ifMatch: '"x"' })).rejects.toThrow(/Refusing to touch/);
    await expect(edge.store.get(key)).rejects.toThrow(/Refusing to touch/);
    await expect(edge.store.head(key)).rejects.toThrow(/Refusing to touch/);
    await expect(edge.store.list(key)).rejects.toThrow(/Refusing to touch/);
  });

  it("has no way to delete or to write unconditionally", () => {
    const operations = Object.getOwnPropertyNames(Object.getPrototypeOf(edge.store)).filter((name) => name !== "constructor").sort();
    expect(operations).toEqual(["createOnly", "destroy", "get", "head", "list", "put", "replaceIfMatch"]);
  });

  it("leaves private objects in the bucket untouched and unlisted", async () => {
    await edge.bucket.put("private/owner-notes.txt", "secret");
    expect((await edge.store.list("public-demo/")).some((object) => object.key.startsWith("private/"))).toBe(false);
    expect(await (await edge.bucket.get("private/owner-notes.txt"))!.text()).toBe("secret");
  });

  it("rejects wrong credentials", async () => {
    const intruder = new S3ReleaseStore({ ...edge.storeConfig, secretAccessKey: "not-the-secret" });
    try { await expect(intruder.list("public-demo/")).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } }); } finally { intruder.destroy(); }
  });
});

describe("publisher settings", () => {
  const valid = { PUBLIC_DEMO_S3_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", PUBLIC_DEMO_S3_BUCKET: "frameflow-public-demo-staging", PUBLIC_DEMO_S3_ACCESS_KEY_ID: "key", PUBLIC_DEMO_S3_SECRET_ACCESS_KEY: "secret" };

  it("reads only its own PUBLIC_DEMO_S3_* variables", () => {
    const config = loadStoreConfig({ ...valid, S3_ENDPOINT: "http://frameflow-minio:9000", S3_BUCKET: "frameflow", S3_ACCESS_KEY_ID: "private-key", S3_SECRET_ACCESS_KEY: "private-secret" });
    expect(config).toEqual({ endpoint: valid.PUBLIC_DEMO_S3_ENDPOINT, bucket: "frameflow-public-demo-staging", accessKeyId: "key", secretAccessKey: "secret", region: "auto", forcePathStyle: true });
  });

  it("does not fall back to the application's private bucket settings", () => {
    expect(() => loadStoreConfig({ S3_ENDPOINT: "http://frameflow-minio:9000", S3_BUCKET: "frameflow", S3_ACCESS_KEY_ID: "private-key", S3_SECRET_ACCESS_KEY: "private-secret" })).toThrow(/Missing PUBLIC_DEMO_S3_ENDPOINT, PUBLIC_DEMO_S3_BUCKET, PUBLIC_DEMO_S3_ACCESS_KEY_ID, PUBLIC_DEMO_S3_SECRET_ACCESS_KEY/);
  });

  it.each([
    ["the private bucket", { PUBLIC_DEMO_S3_BUCKET: "frameflow" }, /dedicated public demo bucket/],
    ["a bucket name with invalid characters", { PUBLIC_DEMO_S3_BUCKET: "Public-Demo_Bucket" }, /dedicated public demo bucket/],
    ["a plain-HTTP remote endpoint", { PUBLIC_DEMO_S3_ENDPOINT: "http://storage.example.com" }, /must use https/],
    ["an endpoint with credentials in it", { PUBLIC_DEMO_S3_ENDPOINT: "https://user:pass@storage.example.com" }, /must not carry/],
    ["an endpoint that is not a URL", { PUBLIC_DEMO_S3_ENDPOINT: "storage" }, /must be a URL/],
    // With path-style addressing, a path here would be taken for the bucket and the name check below would check nothing.
    ["an endpoint with a path", { PUBLIC_DEMO_S3_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/frameflow" }, /origin without a path/],
    ["an unclear path-style setting", { PUBLIC_DEMO_S3_FORCE_PATH_STYLE: "maybe" }, /must be true or false/],
  ])("rejects %s", (_name, change, message) => { expect(() => loadStoreConfig({ ...valid, ...change })).toThrow(message); });

  it("accepts a plain-HTTP endpoint only on this machine", () => {
    expect(loadStoreConfig({ ...valid, PUBLIC_DEMO_S3_ENDPOINT: "http://127.0.0.1:8787/cdn-cgi/local/r2/s3", PUBLIC_DEMO_S3_BUCKET: "frameflow-public-demo-local" }).endpoint).toBe("http://127.0.0.1:8787/cdn-cgi/local/r2/s3");
  });
});
