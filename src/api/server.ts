import "dotenv/config";
import { loadConfig } from "../config.js";
import { HatchetWorkflowSubmitter } from "../services/workflow-submitter.js";
import { buildApp } from "./app.js";
import { createObjectStorage } from "../storage/create-storage.js";
import { SupabaseAuthVerifier } from "../services/auth.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({
    config,
    submitter: new HatchetWorkflowSubmitter(),
    storage: createObjectStorage(),
    ...(config.supabase ? { authVerifier: new SupabaseAuthVerifier(config.supabase) } : {}),
    logger: true,
  });
  await app.listen({ port: config.port, host: "127.0.0.1" });
}

main().catch((error: unknown) => { console.error("API failed:", error); process.exitCode = 1; });
