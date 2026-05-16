import { stat } from "node:fs/promises";
import path from "node:path";
import { V1TaskStatus } from "@hatchet-dev/typescript-sdk/clients/rest/generated/data-contracts.js";
import { VideoRepository, type VideoRecord } from "../db/video-repository.js";
import { hatchet } from "../hatchet-client.js";
import { sanitizeWorkflowFailure } from "./status-projection.js";
import type { ObjectStorage } from "../storage/object-storage.js";

export type InspectedRun = {
  status: "queued" | "running" | "completed" | "failed";
  finalOutput?: { masterPlaylistPath?: string; masterPlaylistObjectKey?: string };
  errors?: Record<string, string>;
};

export interface RunInspector { inspect(runId: string): Promise<InspectedRun>; }

export class HatchetRunInspector implements RunInspector {
  async inspect(runId: string): Promise<InspectedRun> {
    const details = await hatchet.runs.getDetails(runId);
    const status = details.status === V1TaskStatus.COMPLETED ? "completed"
      : details.status === V1TaskStatus.FAILED || details.status === V1TaskStatus.CANCELLED ? "failed"
        : details.status === V1TaskStatus.RUNNING ? "running" : "queued";
    const tasks = Object.values(details.taskRuns);
    const completion = tasks.find((task) => task.readableId === "complete" || task.readableId === "mark-completed")?.output as InspectedRun["finalOutput"];
    const errors = Object.fromEntries(tasks.filter((task) => task.error).map((task) => [task.readableId, task.error!])) as Record<string, string>;
    return { status, finalOutput: completion, errors };
  }
}

async function existingMaster(record: VideoRecord, outputDir: string): Promise<string | undefined> {
  const candidates = [record.masterPlaylistPath, path.join(outputDir, record.id, "master.m3u8")].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const root = path.resolve(outputDir, record.id);
    if (resolved !== path.join(root, "master.m3u8")) continue;
    try { if ((await stat(resolved)).isFile()) return resolved; } catch { /* try next candidate */ }
  }
  return undefined;
}

export async function reconcileVideos(options: {
  repository: VideoRepository;
  inspector: RunInspector;
  outputDir: string;
  storage?: ObjectStorage;
  staleBefore: string;
  log?: (message: string) => void;
}): Promise<{ inspected: number; repaired: number }> {
  const records = options.repository.listStaleActive(options.staleBefore);
  let repaired = 0;
  for (const record of records) {
    if (!record.hatchetRunId) continue;
    let run: InspectedRun;
    try { run = await options.inspector.inspect(record.hatchetRunId); } catch (error) {
      options.log?.(`Could not inspect ${record.id}: ${error instanceof Error ? error.message : "unknown error"}`);
      continue;
    }
    if (run.status === "completed") {
      if (record.sourceObjectKey && record.outputPrefix && options.storage) {
        const masterKey = run.finalOutput?.masterPlaylistObjectKey ?? record.masterPlaylistObjectKey ?? `${record.outputPrefix}/master.m3u8`;
        if (!(await options.storage.headObject(masterKey))) {
          options.log?.(`Hatchet completed ${record.id}, but master object ${masterKey} was not found`);
          continue;
        }
        options.repository.markObjectCompleted(record.id, masterKey);
        repaired += 1;
        options.log?.(`Repaired ${record.id}: ${record.status} -> completed`);
        continue;
      }
      const master = await existingMaster(record, options.outputDir)
        ?? (run.finalOutput?.masterPlaylistPath ? await existingMaster({ ...record, masterPlaylistPath: run.finalOutput.masterPlaylistPath }, options.outputDir) : undefined);
      if (!master) {
        options.log?.(`Hatchet completed ${record.id}, but no safe master playlist was found`);
        continue;
      }
      options.repository.markCompleted(record.id, master);
      repaired += 1;
      options.log?.(`Repaired ${record.id}: ${record.status} -> completed`);
    } else if (run.status === "failed") {
      const safe = sanitizeWorkflowFailure(run.errors ?? {});
      options.repository.markFailed(record.id, safe.code, safe.message);
      repaired += 1;
      options.log?.(`Repaired ${record.id}: ${record.status} -> failed`);
    } else if (run.status === "running" && record.status === "queued") {
      options.repository.markProcessing(record.id);
      repaired += 1;
      options.log?.(`Repaired ${record.id}: queued -> processing`);
    }
  }
  return { inspected: records.length, repaired };
}
