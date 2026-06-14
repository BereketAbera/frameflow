import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const sourcePath = path.resolve(process.argv[2] ?? "input/sample.mp4");
const origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
const timeoutAt = Date.now() + Number(process.env.E2E_TIMEOUT_MS ?? 180_000);

async function json(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Request failed with ${response.status}`);
  return body;
}

async function main() {
  const metadata = await stat(sourcePath);
  const filename = path.basename(sourcePath);
  console.log(`Uploading ${filename} (${metadata.size} bytes)`);
  const created = await json(await fetch(`${origin}/api/videos/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename, contentType: "video/mp4", sizeBytes: metadata.size }),
  }));
  const bytes = await readFile(sourcePath);
  const upload = await fetch(created.upload.url, { method: "PUT", headers: created.upload.headers, body: bytes });
  if (!upload.ok) throw new Error(`Object upload failed with ${upload.status}`);
  await json(await fetch(`${origin}/api${created.completeUrl}`, { method: "POST" }));
  console.log(`Queued video ${created.videoId}`);

  while (Date.now() < timeoutAt) {
    const video = await json(await fetch(`${origin}/api/videos/${created.videoId}`));
    console.log(`Status: ${video.status}`);
    if (video.status === "failed") throw new Error(video.error?.message ?? "Video processing failed");
    if (video.status === "completed") {
      const manifest = await fetch(`${origin}${video.playbackUrl}`);
      if (!manifest.ok || !(await manifest.text()).startsWith("#EXTM3U")) throw new Error("Published HLS manifest is not playable");
      console.log(`PASS ${origin}${video.playerUrl}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Timed out waiting for video processing");
}

main().catch((error: unknown) => {
  console.error("E2E failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
