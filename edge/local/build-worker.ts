import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const edgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const workerBundle = path.join(edgeRoot, ".build", "index.js");

/**
 * The tests run the same bundle a deploy uploads: `wrangler deploy --dry-run` writes it without contacting Cloudflare
 * and without credentials.
 */
export default function buildWorker(): void {
  execFileSync(process.execPath, [path.join(edgeRoot, "node_modules", "wrangler", "bin", "wrangler.js"), "deploy", "--dry-run", "--outdir", ".build"], {
    cwd: edgeRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
}
