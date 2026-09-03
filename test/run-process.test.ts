import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProcess } from "../src/services/ffmpeg.js";
import { Semaphore } from "../src/services/encoding-semaphore.js";
import { withScratch } from "../src/services/object-processing.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const quiet = () => undefined;
const node = (script: string, ...args: string[]): [string, string[]] => [process.execPath, ["-e", script, ...args]];
// Writes its pid to argv[1] once it is running, then idles until it is killed.
const idleChild = (pidFile: string, ignoreTerm = false) => node(`${ignoreTerm ? "process.on('SIGTERM', () => {});" : ""}require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`, pidFile);
async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  for (const deadline = Date.now() + timeoutMs; !condition(); await new Promise((resolve) => setTimeout(resolve, 10))) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
  }
}
const isRunning = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("runProcess cancellation", () => {
  let root = "";
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "run-process-")); vi.mocked(spawn).mockClear(); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("kills a long-running child as soon as the signal aborts", async () => {
    const pidFile = path.join(root, "child.pid"), controller = new AbortController();
    const run = runProcess(...idleChild(pidFile), quiet, { signal: controller.signal });
    await waitFor(() => existsSync(pidFile));
    const pid = Number(await readFile(pidFile, "utf8")), abortedAt = Date.now();
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(Date.now() - abortedAt).toBeLessThan(2_000);
    expect(isRunning(pid)).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const pidFile = path.join(root, "stubborn.pid"), controller = new AbortController();
    const run = runProcess(...idleChild(pidFile, true), quiet, { signal: controller.signal, killAfterMs: 300 });
    await waitFor(() => existsSync(pidFile));
    const pid = Number(await readFile(pidFile, "utf8")), abortedAt = Date.now();
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(250);
    expect(Date.now() - abortedAt).toBeLessThan(3_000);
    expect(isRunning(pid)).toBe(false);
  });

  it("never spawns when the signal is already aborted", async () => {
    await expect(runProcess(...node("process.exit(0)"), quiet, { signal: AbortSignal.abort(new Error("cancelled")) })).rejects.toMatchObject({ name: "AbortError", cause: new Error("cancelled") });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("settles once and stops listening after a normal exit", async () => {
    const controller = new AbortController(), removed = vi.spyOn(controller.signal, "removeEventListener");
    await expect(runProcess(...node("process.stdout.write('done')"), quiet, { signal: controller.signal })).resolves.toBe("done");
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    await expect(runProcess(...node("process.exit(3)"), quiet)).rejects.toThrow(/failed \(exit 3/);
  });

  it("lets withScratch remove its directory when the work inside is aborted", async () => {
    const scratch = path.join(root, "scratch"), controller = new AbortController();
    let directory = "";
    const run = withScratch(scratch, "encode-360p", async (dir) => {
      directory = dir;
      await writeFile(path.join(dir, "segment-000.ts"), "partial output");
      return runProcess(...node("setInterval(() => {}, 1000)"), quiet, { signal: controller.signal });
    });
    await waitFor(() => directory !== "" && vi.mocked(spawn).mock.calls.length === 1);
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(directory)).toBe(false);
    expect(await readdir(scratch)).toEqual([]);
  });
});

describe("encoding semaphore", () => {
  it("never runs more than its maximum at once", async () => {
    const semaphore = new Semaphore(2);
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => semaphore.run(async () => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1; })));
    expect(peak).toBe(2);
  });

  it("drops an aborted waiter without spending a slot", async () => {
    const semaphore = new Semaphore(1), controller = new AbortController();
    let finishFirst!: () => void;
    const first = semaphore.run(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    const operation = vi.fn(async () => "ran");
    const waiting = semaphore.run(operation, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    finishFirst();
    await first;
    await expect(semaphore.run(async () => "next")).resolves.toBe("next");
    expect(operation).not.toHaveBeenCalled();
    await expect(semaphore.run(operation, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  });

  it("releases the slot when the running operation is aborted", async () => {
    const semaphore = new Semaphore(1), controller = new AbortController();
    const running = semaphore.run(() => runProcess(...node("setInterval(() => {}, 1000)"), quiet, { signal: controller.signal }), controller.signal);
    const next = semaphore.run(async () => "after the abort");
    setTimeout(() => controller.abort(), 50);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await expect(next).resolves.toBe("after the abort");
  });
});
