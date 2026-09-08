# Local video-processing POC

Phase 3 processes MP4 uploads into adaptive 360p/720p HLS using Hatchet and FFmpeg without requiring the API and worker to share a media filesystem. The API stores product status in SQLite; source and HLS media live in a private S3-compatible bucket (MinIO locally).

## Architecture

```text
browser -> API creates upload -> presigned PUT -> private object storage
   |                                  |
   +-> confirms upload -> Hatchet Phase 3 DAG
                              | ffprobe + parallel FFmpeg in isolated scratch dirs
                              +-> staging/{runId} -> published HLS (master last)
                              +-> authenticated status callback -> API -> SQLite

browser <- API streams allowlisted private HLS objects <- object storage
```

Hatchet is the workflow-execution source of truth. SQLite is the product-facing projection used for polling. Workflow payloads contain object keys only; video bytes are streamed through storage, and every task independently downloads its input into disposable scratch space. Phase 1 and the legacy Phase 2 workflow remain registered for compatibility.

## Setup

Requires Node 24+, npm, Docker, FFmpeg/ffprobe, and Hatchet Cloud or a self-hosted Hatchet server.

```bash
cd /Users/bek/dev/pr/video-processing-poc
npm install
cp .env.example .env
# Set HATCHET_CLIENT_TOKEN in .env
docker compose -f docker-compose.minio.yml up -d
npm run db:init
```

MinIO runs at `http://127.0.0.1:9000`, its console at `http://127.0.0.1:9001`, and the one-shot initializer creates a private bucket with development CORS rules. Credentials and the bucket can be overridden through the matching `S3_*` environment variables.

Important configuration:

| Variable | Default |
| --- | --- |
| `PORT` | `3000` |
| `DATABASE_PATH` | `./data/app.db` |
| `S3_ENDPOINT` | `http://127.0.0.1:9000` |
| `S3_REGION` | `us-east-1` |
| `S3_BUCKET` | `video-processing-poc` |
| `S3_FORCE_PATH_STYLE` | `true` |
| `S3_PRESIGNED_UPLOAD_TTL_SECONDS` | `600` |
| `WORKER_TEMP_DIR` | `./.worker-tmp` |
| `MAX_UPLOAD_BYTES` | `524288000` |
| `STATUS_CALLBACK_BASE_URL` | `http://127.0.0.1:3000` |
| `WORKER_CALLBACK_SECRET` | development-only value in `.env.example` |

For AWS S3, omit `S3_ENDPOINT`, use the appropriate region and credentials, and normally set `S3_FORCE_PATH_STYLE=false`. The storage constructor rejects missing bucket, region, or credentials, while `/health/ready` verifies both SQLite and bucket access.

## Run and upload

Start these in separate terminals:

```bash
npm run worker
npm run api
```

Open `http://127.0.0.1:3000/upload`, or perform the direct-upload protocol manually:

```bash
curl -sS -X POST http://127.0.0.1:3000/videos/uploads \
  -H 'content-type: application/json' \
  -d '{"filename":"sample.mp4","contentType":"video/mp4","sizeBytes":123456}'

curl -X PUT '<upload.url from response>' \
  -H 'content-type: video/mp4' --upload-file ./input/sample.mp4

curl -X POST http://127.0.0.1:3000/videos/<videoId>/upload-complete
curl http://127.0.0.1:3000/videos/<videoId>
```

The declared size must exactly match the uploaded object's size. Confirmation is idempotent and concurrent confirmations coalesce to one Hatchet submission. The previous multipart `POST /videos` upload is intentionally removed; clients must use the presigned flow.

Other routes are `GET /videos`, `GET /player/{videoId}`, `GET /streams/{videoId}/master.m3u8`, `GET /health/live`, and `GET /health/ready`.

The bucket remains private. Playback goes through the API, which requires a completed record and only serves the master, known rendition playlists, and numbered transport-stream segments under that video's published prefix.

## Storage layout and publication

```text
videos/{videoId}/source/source.mp4
videos/{videoId}/staging/{workflowRunId}/{360p|720p}/...
videos/{videoId}/published/{360p|720p}/...
videos/{videoId}/published/master.m3u8
```

Renditions upload to a run-specific staging prefix. Publication copies rendition objects first and uploads the master playlist last, so a master never advertises incomplete output. Publication is retry-safe after partial copying or cleanup, and success removes its staging prefix. Object keys are generated from validated IDs rather than client filenames and are validated at the storage boundary.

## Database and migration behavior

Migration `002_object_storage.sql` adds source/output keys, upload lifecycle, expiry, ETag, and actual/declared size fields without modifying migration 001. New records never use persistent local media paths. Existing Phase 2 rows retain their local paths and continue through legacy reconciliation; they are not silently converted because no object upload can be inferred safely.

Status transitions remain monotonic: `uploading -> uploaded -> queued -> processing -> completed|failed`, with expired uploads becoming failed.

## Reconciliation and cleanup

```bash
npm run reconcile
npm run cleanup          # dry-run plan only
npm run cleanup -- --apply
```

Reconciliation inspects stale queued/processing rows with Hatchet run IDs. It repairs running, failed, and completed drift, but marks object-backed completion only after the published master exists. Ambiguous records are logged and left unchanged.

Cleanup expires abandoned presigned uploads, removes staging prefixes belonging to terminal records, and removes old worker scratch directories. It is dry-run by default, constrained to known video prefixes/scratch roots, and idempotent. `CLEANUP_STALE_HOURS` controls scratch age.

## Verification

```bash
npm run typecheck
npm test
npm run db:init
```

Tests use fake object storage and temporary databases/directories. They cover direct-upload validation and idempotency, private HLS allowlisting, storage readiness, independent worker scratch, bounded staged uploads, master-last publication, reconciliation, cleanup dry-run/apply, terminal transitions, and playable FFmpeg output.

To prove filesystem separation, start API and worker with distinct media and scratch directories; only status callbacks and object storage connect them:

```bash
UPLOAD_DIR=/tmp/api-unused OUTPUT_DIR=/tmp/api-unused-output npm run api
WORKER_TEMP_DIR=/tmp/video-worker-scratch UPLOAD_DIR=/tmp/worker-unused OUTPUT_DIR=/tmp/worker-unused-output npm run worker
```

For the retry demonstration, start the API with `FORCE_720P_FAILURE_ONCE=true`; the workflow intentionally fails the first 720p attempt and succeeds on retry without rerunning completed parents.

## Limits

- There is no end-user authentication or ownership model.
- SQLite is still a single-node API persistence choice, although workers do not access it or share media directories.
- The FFmpeg semaphore is per worker process, not distributed.
- Stronger content inspection, object lifecycle policies, multipart-resume UX, CDN delivery, and distributed admission control remain future work.
- hls.js is loaded from jsDelivr when native HLS is unavailable.
- A crash after Hatchet accepts a run but before the API records its run ID remains ambiguous; reconciliation deliberately does not guess through it.
