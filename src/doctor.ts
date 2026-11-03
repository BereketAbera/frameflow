import "dotenv/config";
import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";

type Check = { name: string; ok: boolean; detail: string };

function commandVersion(command: string): Promise<Check> {
  return new Promise((resolve) => {
    const child = spawn(command, ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.on("error", () => resolve({ name: command, ok: false, detail: "not found" }));
    child.on("close", (code) => resolve({ name: command, ok: code === 0, detail: output.split("\n")[0]?.trim() || `exit ${code}` }));
  });
}

async function endpointCheck(name: string, url: string): Promise<Check> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_500) });
    return { name, ok: response.ok, detail: response.ok ? url : `HTTP ${response.status}` };
  } catch {
    return { name, ok: false, detail: `unreachable at ${url}` };
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const checks = await Promise.all([
    commandVersion("ffmpeg"),
    commandVersion("ffprobe"),
    endpointCheck("MinIO", `${config.s3.endpoint ?? "https://s3.amazonaws.com"}/minio/health/live`),
  ]);
  checks.push({ name: "Hatchet token", ok: Boolean(process.env.HATCHET_CLIENT_TOKEN), detail: process.env.HATCHET_CLIENT_TOKEN ? "configured" : "missing in .env" });
  checks.push({ name: "Authentication", ok: true, detail: config.supabase ? "Supabase enabled" : "local development user" });
  console.log("\nFrameflow local environment\n");
  for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name.padEnd(16)} ${check.detail}`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
