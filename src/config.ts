import path from "node:path";

export type AppConfig = {
  port: number;
  databasePath: string;
  uploadDir: string;
  outputDir: string;
  maxUploadBytes: number;
  reconciliationStaleMinutes: number;
  maxConcurrentEncodes: number;
};

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const dataDir = path.resolve(cwd, "data");
  return {
    port: positiveInteger(env.PORT, 3000, "PORT"),
    databasePath: path.resolve(env.DATABASE_PATH ?? path.join(dataDir, "app.db")),
    uploadDir: path.resolve(env.UPLOAD_DIR ?? path.join(dataDir, "uploads")),
    outputDir: path.resolve(env.OUTPUT_DIR ?? path.join(dataDir, "output")),
    maxUploadBytes: positiveInteger(env.MAX_UPLOAD_BYTES, 500 * 1024 * 1024, "MAX_UPLOAD_BYTES"),
    reconciliationStaleMinutes: positiveInteger(env.RECONCILIATION_STALE_MINUTES, 15, "RECONCILIATION_STALE_MINUTES"),
    maxConcurrentEncodes: positiveInteger(env.MAX_CONCURRENT_ENCODES, 2, "MAX_CONCURRENT_ENCODES"),
  };
}
