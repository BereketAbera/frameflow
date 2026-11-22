/**
 * Runs the whole public demo on this machine: the built Worker in workerd, a local R2 bucket behind it, and that
 * bucket's local S3 endpoint for the publisher. Nothing here talks to Cloudflare.
 *
 *   npm run demo:local                 # then, in another terminal, the release commands it prints
 */
import { parseArgs } from "node:util";
import buildWorker from "../local/build-worker.js";
import { startLocalEdge } from "../local/runtime.js";

const { values } = parseArgs({ options: { port: { type: "string", default: "8787" } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be a port number");

buildWorker();
const edge = await startLocalEdge({ port, environment: "local" });
const { storeConfig } = edge;
// These are fixed values of the local runtime, not secrets: they open nothing but the bucket this process just created in memory.
const environment = `PUBLIC_DEMO_S3_ENDPOINT=${storeConfig.endpoint} PUBLIC_DEMO_S3_BUCKET=${storeConfig.bucket} PUBLIC_DEMO_S3_ACCESS_KEY_ID=${storeConfig.accessKeyId} PUBLIC_DEMO_S3_SECRET_ACCESS_KEY=${storeConfig.secretAccessKey}`;
console.log(`Public demo running locally. The bucket is empty and lives only as long as this process.

  Player   ${edge.origin}/public-demo/
  Active   ${edge.origin}/public-demo/current.json

Publish to it from another terminal, in edge/:

  ${environment} npm run release -- publish <package-dir> --promote
  ${environment} npm run release -- status

Press Ctrl+C to stop.`);

const stop = async () => { await edge.dispose(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
