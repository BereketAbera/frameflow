/** The release command as an operator runs it: exit codes, what it prints, and the flags the staging steps rely on. */
import { execFile } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { edgeRoot } from "../local/build-worker.js";
import { startLocalEdge, type LocalEdge } from "../local/runtime.js";
import { workspace, type Workspace } from "./support/fixtures.js";
import type { ReleaseManifest } from "../src/shared/contract.js";

let edge: LocalEdge, files: Workspace, a: { directory: string; manifest: ReleaseManifest }, b: typeof a;
beforeAll(async () => { edge = await startLocalEdge(); files = await workspace(); a = await files.package("a"); b = await files.package("b"); });
afterAll(async () => { await edge.dispose(); await files.cleanup(); });

type Outcome = { code: number; stdout: string; stderr: string };
function release(args: string[], environment?: Record<string, string>): Promise<Outcome> {
  const settings = environment ?? { PUBLIC_DEMO_S3_ENDPOINT: edge.storeConfig.endpoint, PUBLIC_DEMO_S3_BUCKET: edge.storeConfig.bucket, PUBLIC_DEMO_S3_ACCESS_KEY_ID: edge.storeConfig.accessKeyId, PUBLIC_DEMO_S3_SECRET_ACCESS_KEY: edge.storeConfig.secretAccessKey };
  return new Promise((resolve) => {
    // Only what is listed reaches the command: none of the machine's own settings, and none of the application's.
    execFile(process.execPath, ["--import", "tsx", path.join("src", "publisher", "cli.ts"), ...args], { cwd: edgeRoot, env: { PATH: process.env.PATH ?? "", ...settings } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}
const activeNow = async () => ((await (await edge.fetch("/public-demo/current.json")).json()) as { release?: string }).release ?? null;

describe("the release command", () => {
  it("explains itself and exits 2 on a usage error", async () => {
    for (const args of [[], ["launch"], ["publish"], ["promote"], ["verify"], ["status", "--force"], ["package", "--hls", "x"]]) {
      const outcome = await release(args);
      expect([args.join(" "), outcome.code]).toEqual([args.join(" "), 2]);
      expect(outcome.stdout + outcome.stderr).toContain("Frameflow public demo releases");
    }
    expect((await release(["--help"])).code).toBe(2);
    expect((await release(["status", "--help"])).code).toBe(0);
  });

  it("refuses to touch a bucket without its own settings, and never falls back to the application's", async () => {
    const outcome = await release(["status"], { S3_ENDPOINT: edge.storeConfig.endpoint, S3_BUCKET: edge.storeConfig.bucket, S3_ACCESS_KEY_ID: edge.storeConfig.accessKeyId, S3_SECRET_ACCESS_KEY: edge.storeConfig.secretAccessKey });
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain("Missing PUBLIC_DEMO_S3_ENDPOINT");
    const wrongBucket = await release(["status"], { PUBLIC_DEMO_S3_ENDPOINT: edge.storeConfig.endpoint, PUBLIC_DEMO_S3_BUCKET: "frameflow", PUBLIC_DEMO_S3_ACCESS_KEY_ID: "x", PUBLIC_DEMO_S3_SECRET_ACCESS_KEY: "y" });
    expect([wrongBucket.code, wrongBucket.stderr.includes("dedicated public demo bucket")]).toEqual([2, true]);
  });

  it("reports an empty bucket", async () => {
    const outcome = await release(["status"]);
    expect([outcome.code, outcome.stdout.trim()]).toEqual([0, "Active: none"]);
  });

  it("--interrupt-after stops a publish early, exits 1 and leaves nothing active", async () => {
    const outcome = await release(["publish", a.directory, "--promote", "--expect-active", "none", "--interrupt-after", "4"]);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toMatch(/^FAILED at upload: Upload of a-[0-9a-f]{16} stopped: interrupted on purpose after 4 uploads/);
    expect(await activeNow()).toBeNull();
    expect((await release(["status"])).stdout).toMatch(new RegExp(`${a.manifest.id}  INCOMPLETE  4 objects`));
    const promote = await release(["promote", a.manifest.id]);
    expect([promote.code, promote.stderr.startsWith("FAILED at promote:")]).toEqual([1, true]);
  });

  it("publishes, with --promote and --expect-active none for a first release", async () => {
    const outcome = await release(["publish", a.directory, "--promote", "--expect-active", "none"]);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain("Uploaded 7 objects, found 4 already in the bucket.");
    expect(outcome.stdout).toContain(`Published and promoted ${a.manifest.id}.`);
    expect(await activeNow()).toBe(a.manifest.id);
    // "none" is an expectation like any other: it no longer holds.
    const again = await release(["publish", b.directory, "--promote", "--expect-active", "none"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/^FAILED at promote: Expected no release to be active/);
    expect(await activeNow()).toBe(a.manifest.id);
  });

  it("prints machine-readable results with --json, and nothing else", async () => {
    const promote = await release(["promote", b.manifest.id, "--expect-active", a.manifest.id, "--json"]);
    expect(promote.code).toBe(0);
    expect(JSON.parse(promote.stdout)).toEqual({ changed: true, activeRelease: b.manifest.id, previousRelease: a.manifest.id, sequence: 2 });
    const status = JSON.parse((await release(["status", "--json"])).stdout) as { active: { activeRelease: string }; releases: Array<{ releaseId: string; complete: boolean }> };
    expect(status.active.activeRelease).toBe(b.manifest.id);
    expect(status.releases.map((entry) => [entry.releaseId, entry.complete])).toEqual([[a.manifest.id, true], [b.manifest.id, true]]);
  });

  it("rolls back, verifies, and fails clearly on what it cannot do", async () => {
    const rollback = await release(["rollback"]);
    expect([rollback.code, rollback.stdout.includes(`Rolled back to ${a.manifest.id}.`)]).toEqual([0, true]);
    expect(await activeNow()).toBe(a.manifest.id);
    expect((await release(["verify", b.manifest.id])).stdout).toContain(`${b.manifest.id} is intact: 11 files match the manifest.`);
    for (const args of [["promote", "zz-0000000000000000"], ["promote", "../../private"], ["verify", "zz-0000000000000000"], ["rollback", "--to", "zz-0000000000000000"], ["publish", path.join(files.root, "nowhere")]]) {
      const outcome = await release(args);
      expect([args.join(" "), outcome.code, outcome.stderr.startsWith("FAILED at ")]).toEqual([args.join(" "), 1, true]);
      // An expected failure is one line, not a stack trace.
      expect(outcome.stderr.trim().split("\n")).toHaveLength(1);
    }
    expect(await activeNow()).toBe(a.manifest.id);
  });

  it("has no command that deletes", async () => {
    for (const command of ["discard", "delete", "remove", "purge"]) expect((await release([command, a.manifest.id])).code).toBe(2);
    expect((await release(["verify", a.manifest.id])).code).toBe(0);
  });
});
