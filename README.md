# Local video-processing POC

Phase 1 converts a local MP4 into adaptive 360p/720p HLS with a Hatchet DAG. Phase 2 adds a Fastify upload/status API, application-owned SQLite status projection, guarded HLS delivery, browser player, and explicit reconciliation.

## Architecture

```text
browser/curl -> Fastify -> data/uploads/{videoId}/source.mp4 -> Hatchet Phase 2 DAG
                    |                                      -> ffprobe + parallel FFmpeg
                    v                                      -> data/output/{videoId}/
             SQLite videos projection <--- workflow hooks           |
                    ^                                      guarded /streams + player
                    +------------- status polling ------------------+
```

Hatchet is the workflow-execution source of truth. `data/app.db` is the separate product-facing projection used by the API; status GETs do not query Hatchet. FFmpeg remains independent of Fastify and SQLite.

## Setup

Requires Node 24+, npm, FFmpeg/ffprobe, and Hatchet Cloud or a self-hosted server.

```bash
cd /Users/bek/dev/pr/video-processing-poc
npm install
cp .env.example .env
# add HATCHET_CLIENT_TOKEN to .env
npm run db:init
```

Configuration and safe defaults:

| Variable | Default |
| --- | --- |
| `PORT` | `3000` |
| `DATABASE_PATH` | `./data/app.db` |
| `UPLOAD_DIR` | `./data/uploads` |
| `OUTPUT_DIR` | `./data/output` |
| `MAX_UPLOAD_BYTES` | `524288000` |
| `RECONCILIATION_STALE_MINUTES` | `15` |
| `MAX_CONCURRENT_ENCODES` | `2` |

For a local Docker-backed Hatchet server:

```bash
hatchet server start --disable-auth --project-name video-processing-poc-hatchet \
  --profile video-processing-poc-local
```

Copy its worker token into `.env`, then set `HATCHET_CLIENT_HOST_PORT=127.0.0.1:7077` and `HATCHET_CLIENT_TLS_STRATEGY=none`.

## Run Phase 2

Terminal 1:

```bash
npm run worker
```

Terminal 2:

```bash
npm run api
```

Upload and use the returned URLs:

```bash
curl -X POST -F "video=@./input/sample.mp4;type=video/mp4" \
  http://127.0.0.1:3000/videos
curl http://127.0.0.1:3000/videos/<videoId>
```

Open `http://127.0.0.1:3000/player/<videoId>`. The page polls every two seconds, stops at `completed`/`failed`, uses native HLS when available, and otherwise uses hls.js.

Other endpoints:

```bash
curl http://127.0.0.1:3000/health
curl 'http://127.0.0.1:3000/videos?limit=20'
ffprobe http://127.0.0.1:3000/streams/<videoId>/master.m3u8
```

## Persistence and consistency

Migration `001_create_videos.sql` creates the typed model and indexes. `npm run db:init` applies versioned migrations transactionally and is safe to rerun.

```text
uploading -> uploaded -> queued -> processing -> completed
                                            \-> failed
```

Terminal states cannot regress. Intermediate Hatchet retries do not mark failure; the `onFailure` task runs after retry exhaustion. Completion is written only after all output is atomically published. Hatchet status-based idempotency uses `videoId` to collapse simultaneous duplicate active submissions.

There is no transaction shared by SQLite and Hatchet. The API persists the upload, submits with a stable ID, then attaches the run ID. It handles a worker starting or completing before that attachment without regressing state. A process crash after Hatchet accepts a run but before its ID is returned can still create an orphan run and a record without a run ID; automatic discovery of that narrow window is outside Phase 2.

## Reconciliation

```bash
npm run reconcile
```

This inspects only stale `queued`/`processing` records with run IDs. It can repair queued to processing, terminal Hatchet failure, and Hatchet completion when the safe expected master playlist exists. Every repair is logged, terminal rows are excluded, and repeated runs are idempotent. Missing run IDs or output are skipped rather than guessed.

## Upload and stream safety

- Uploads stream to a fixed server filename and never use the client filename as a path.
- Exactly one `video` field is accepted; file size, `.mp4`, `video/mp4`, and ISO-BMFF `ftyp` signature are checked.
- Partial files are removed. Full ffprobe validation and the minimum 1280x720 rule happen in Hatchet.
- Status responses omit source paths, credentials, stack traces, and raw worker errors.
- Streams require a completed database row and allowlist only the master playlist, known variant playlists, and segment pattern.
- Every stream path is resolved beneath its video-specific output root.
- HLS MIME types and local-playback CORS headers are set explicitly.
- Health checks SQLite and both storage directories, not merely the HTTP process.

A narrow manual stream handler is used instead of a general static mount so completion state and the HLS filename allowlist are enforced on every request.

## Phase 1 CLI and retry demo

```bash
npm run process -- ./input/sample.mp4
FORCE_720P_FAILURE_ONCE=true npm run process -- ./input/sample.mp4
```

The retry flag fails only the first 720p attempt using `ctx.retryCount()`; completed parents are not rerun.

Generate a sample if needed:

```bash
ffmpeg -f lavfi -i "testsrc2=size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000" \
  -t 8 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest ./input/sample.mp4
```

## Verification

```bash
npm run typecheck
npm test
npm run db:init
```

Tests use temporary databases/directories and no live Hatchet server. They cover repository transitions, terminal-state protection, upload acceptance/rejection, status shapes, guarded HLS and traversal, workflow status projection, reconciliation idempotency, and the original FFmpeg pipeline.

## Limits and troubleshooting

- No authentication: anyone reaching the API can upload, list, inspect, and play.
- SQLite and local paths require API and worker to share one machine/filesystem.
- The explicit semaphore permits at most two FFmpeg processes per worker process. Multiple workers multiply that limit; it is not distributed.
- hls.js comes from jsDelivr, so fallback playback needs internet access.
- Node currently prints an experimental warning for its built-in SQLite API.
- A worker crash between output publication and projection update relies on reconciliation.
- Infrastructure failure that prevents Hatchet's failure task itself also relies on reconciliation.

If work stays queued, ensure a current worker registered `video-processing-phase-2`; an old Phase 1 worker cannot claim that workflow. For connection failures, verify the token and local host/TLS settings. For playback issues, confirm completed status and test the stream URL with ffprobe.

Recommended Phase 3 scope: authenticated ownership, object storage, distributed FFmpeg admission control, direct/presigned uploads, retention cleanup, stronger media validation, and handoff observability.
