import path from "node:path";
import { parseArgs } from "node:util";
import { packageRelease } from "./package.js";
import { ReleaseValidationError } from "./inspect.js";
import { ReleaseError, promoteRelease, publishRelease, readStatus, rollbackRelease, verifyRelease } from "./releases.js";
import { S3ReleaseStore, loadStoreConfig, type ReleaseStore } from "./store.js";

const USAGE = `Frameflow public demo releases

  package  --hls <dir> --label <label> --out <dir> [--thumbnail-at <seconds>] [--preview-seconds <seconds>]
           Build a release package from a completed HLS output. Needs FFmpeg. Touches no bucket.
  publish  <package-dir> [--promote] [--expect-active <release-id|none>] [--interrupt-after <count>]
           Validate, upload, verify the bucket copy and commit a release. With --promote, also make it active.
           --interrupt-after stops after that many uploads, to rehearse an interrupted publish.
  promote  <release-id> [--expect-active <release-id|none>]
           Make a complete release the active one.
  rollback [--to <release-id>]
           Return to the previously active release.
  status   Show the active reference and every release in the bucket.
  verify   <release-id>
           Re-validate a complete release in the bucket.

Nothing here deletes or overwrites: objects are only created, and only the active reference is replaced.

Add --json to print the result as JSON. Bucket commands read PUBLIC_DEMO_S3_* from the environment (see .env.example).`;

class UsageError extends Error {}

function number(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`--${name} must be a non-negative number`);
  return parsed;
}

/** "none" means "no release is active", so a first promotion can be made conditional too. */
const expectActive = (value: string | undefined): string | null | undefined => (value === undefined ? undefined : value === "none" ? null : value);

/**
 * A rehearsal aid: the store stops accepting uploads after `uploads` of them, exactly as a publisher that lost its
 * connection would. It can only ever make a publish stop early, which is always safe.
 */
function interrupting(store: ReleaseStore, uploads: number): ReleaseStore {
  let done = 0;
  return new Proxy(store, { get(target, property, receiver) {
    if (property !== "createOnly") { const value: unknown = Reflect.get(target, property, receiver); return typeof value === "function" ? value.bind(target) : value; }
    return async (input: Parameters<ReleaseStore["createOnly"]>[0]) => {
      if (done++ >= uploads) throw new Error(`interrupted on purpose after ${uploads} uploads (--interrupt-after)`);
      return target.createOnly(input);
    };
  } });
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      hls: { type: "string" }, label: { type: "string" }, out: { type: "string" }, "thumbnail-at": { type: "string" }, "preview-seconds": { type: "string" },
      promote: { type: "boolean" }, "expect-active": { type: "string" }, "interrupt-after": { type: "string" }, to: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  const [command, target] = positionals;
  if (values.help || !command) { console.log(USAGE); return command ? 0 : 2; }
  const log = values.json ? () => {} : (message: string) => console.log(message);
  const print = (result: unknown, summary: string) => console.log(values.json ? JSON.stringify(result, null, 2) : summary);

  if (command === "package") {
    if (!values.hls || !values.label || !values.out) throw new UsageError("package needs --hls, --label and --out");
    const manifest = await packageRelease({ hlsDir: path.resolve(values.hls), outDir: path.resolve(values.out), label: values.label, thumbnailAtSeconds: number(values["thumbnail-at"], "thumbnail-at"), previewSeconds: number(values["preview-seconds"], "preview-seconds") });
    print(manifest, `Packaged ${manifest.id} in ${values.out}: ${manifest.files.length} files, ${manifest.files.reduce((total, file) => total + file.size, 0)} bytes, ${manifest.renditions.map((r) => r.name).join(" + ")}, with a thumbnail and a preview.`);
    return 0;
  }

  if (!["publish", "promote", "rollback", "status", "verify"].includes(command)) throw new UsageError(`Unknown command: ${command}`);
  let store: S3ReleaseStore;
  try { store = new S3ReleaseStore(loadStoreConfig()); }
  catch (error) { throw new UsageError((error as Error).message); }
  try {
    if (command === "publish") {
      if (!target) throw new UsageError("publish needs the package directory");
      const interruptAfter = number(values["interrupt-after"], "interrupt-after");
      const result = await publishRelease({ store: interruptAfter === undefined ? store : interrupting(store, interruptAfter), packageDir: path.resolve(target), promote: values.promote, expectActive: expectActive(values["expect-active"]), concurrency: interruptAfter === undefined ? undefined : 1, log });
      print(result, result.promotion ? `Published and promoted ${result.releaseId}.` : `Published ${result.releaseId}. Publishing does not change the active release: "promote ${result.releaseId}" does.`);
    } else if (command === "promote") {
      if (!target) throw new UsageError("promote needs a release ID");
      const result = await promoteRelease({ store, releaseId: target, expectActive: expectActive(values["expect-active"]), log });
      print(result, result.changed ? `Promoted ${result.activeRelease}.` : `${result.activeRelease} was already active.`);
    } else if (command === "rollback") {
      const result = await rollbackRelease({ store, to: values.to, log });
      print(result, `Rolled back to ${result.activeRelease}.`);
    } else if (command === "status") {
      const status = await readStatus(store);
      print(status, [
        status.active ? `Active: ${status.active.activeRelease} (change ${status.active.sequence}, ${status.active.updatedAt}; previous: ${status.active.previousRelease ?? "none"})` : "Active: none",
        ...status.releases.map((release) => `  ${release.releaseId}  ${release.complete ? "complete  " : "INCOMPLETE"}  ${release.objects} objects, ${release.bytes} bytes`),
      ].join("\n"));
    } else {
      if (!target) throw new UsageError("verify needs a release ID");
      const manifest = await verifyRelease(store, target);
      print({ releaseId: manifest.id, files: manifest.files.length, verified: true }, `${manifest.id} is intact: ${manifest.files.length} files match the manifest.`);
    }
    return 0;
  } finally { store.destroy(); }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
  // A mistyped option is a usage problem too, not a crash.
  if (error instanceof UsageError || String((error as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS")) { console.error(`${(error as Error).message}\n\n${USAGE}`); process.exitCode = 2; return; }
  // Expected failures are explained in one line. Anything else is a bug or an outage, and keeps its stack.
  if (error instanceof ReleaseError || error instanceof ReleaseValidationError) console.error(`FAILED${error instanceof ReleaseError ? ` at ${error.step}` : ""}: ${error.message}`);
  else console.error(error);
  process.exitCode = 1;
});
