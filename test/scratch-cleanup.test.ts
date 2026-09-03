import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeStaleScratch, withScratch } from "../src/services/object-processing.js";

describe("worker startup scratch cleanup", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("removes only withScratch directories directly inside the scratch root", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "scratch-cleanup-"));
    const scratch = path.join(root, "worker-tmp"), outside = path.join(root, "outside");
    for (const dir of ["probe-a1B2c3", "encode-360p-x9Y8z7/out/.360p-attempt", "publish-777777", "keep-me/probe-nested", "encoder-notes", "Probe-upper"]) await mkdir(path.join(scratch, dir), { recursive: true });
    await writeFile(path.join(scratch, "probe-a1B2c3", "source.mp4"), "partial download");
    await writeFile(path.join(scratch, "probe-file.txt"), "a file, not a directory");
    await mkdir(outside);
    await writeFile(path.join(outside, "precious.txt"), "outside the scratch root");
    await symlink(outside, path.join(scratch, "encode-link"), "dir");

    expect(await removeStaleScratch(scratch)).toBe(3);
    expect((await readdir(scratch)).sort()).toEqual(["Probe-upper", "encode-link", "encoder-notes", "keep-me", "probe-file.txt"]);
    expect(existsSync(path.join(scratch, "keep-me", "probe-nested"))).toBe(true);
    expect(existsSync(path.join(outside, "precious.txt"))).toBe(true);
    expect(await removeStaleScratch(scratch)).toBe(0);
  });

  it("treats a missing scratch root as clean", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "scratch-cleanup-"));
    expect(await removeStaleScratch(path.join(root, "not-created-yet"))).toBe(0);
  });

  it("only creates directories it can clean up later", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "scratch-cleanup-"));
    await expect(withScratch(root, "encoder", async () => "never")).rejects.toThrow(/Unknown scratch label/);
    await expect(withScratch(root, "encode-720p", async (dir) => path.basename(dir))).resolves.toMatch(/^encode-720p-/);
    expect(await readdir(root)).toEqual([]);
  });
});
