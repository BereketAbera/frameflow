# Frameflow portfolio walkthrough

Frameflow demonstrates a production-shaped local media pipeline rather than a UI-only upload demo. The frontend, API, workflow worker, database projection, and private object storage run as separate responsibilities.

## Recommended five-minute demo

1. Open the workspace and show the live service indicator.
2. Visit **System** to show readiness across Fastify, SQLite, MinIO/S3, and workflow submission.
3. Upload `input/sample.mp4` and point out the direct-to-storage progress bar.
4. On the player page, follow the live Upload → Queue → Transcode → Publish timeline.
5. Play the adaptive HLS output and switch between Auto, 360p, and 720p when the browser uses hls.js.
6. Return to the workspace, demonstrate search/status filters, then explain owner-scoped deletion and private-object cleanup.

For a repeatable terminal demonstration, run `npm run e2e:local`. It generates its own short FFmpeg fixture and proves the same upload-to-playback path without manual browser input.

## Engineering talking points

- Next.js App Router and React are isolated from the Fastify API through same-origin rewrites, keeping cookies and private HLS playback straightforward.
- Supabase owns identity; the API verifies bearer/session tokens and applies the user ID to every video lookup and mutation.
- Upload bytes bypass the API through a short-lived presigned PUT, while the API validates the final object size before workflow submission.
- Hatchet coordinates probe, parallel 360p/720p transcodes, publication, retry behavior, and status callbacks.
- Workers use isolated scratch directories and object keys, so they never depend on the API server's filesystem.
- Publication copies renditions first and the master playlist last, preventing clients from observing an incomplete stream.
- SQLite is intentionally a local product projection; a hosted version would replace it with durable managed Postgres while retaining the API contract.

## Commit narrative

Use `git log --oneline --reverse` to present the work chronologically. The history separates workflow, API, object storage, maintenance, product UI/authentication, React migration, and POC completion rather than collapsing them into one showcase commit.
