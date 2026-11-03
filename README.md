# Frameflow — local video processing platform

Frameflow is an AI-video publishing and discovery platform built from a production-shaped local processing POC. It combines a Next.js 16 / React 19 community experience, optional Supabase authentication, direct-to-object-storage uploads, Hatchet orchestration, and parallel FFmpeg transcoding into adaptive 360p/720p HLS.

The frontend uses the App Router, TypeScript, Tailwind CSS v4, and local shadcn/ui-style component source. See [the UI system guide](./docs/ui-system.md) for the component mapping and extension rules.

## Architecture

```text
Next.js :3000 -> same-origin rewrites -> Fastify API :4000 -> Supabase auth
      |                                      |
      +-> API creates upload -> presigned PUT -> private object storage
      +-> confirms upload -> Hatchet Phase 3 DAG
                              | ffprobe + parallel FFmpeg in isolated scratch dirs
                              +-> staging/{runId} -> published HLS (master last)
                              +-> authenticated status callback -> API -> SQLite

React HLS player <- Next rewrite <- API streams allowlisted objects <- storage
```

Hatchet is the workflow-execution source of truth. SQLite is the product-facing projection used for polling. Supabase owns identity; Frameflow verifies sessions and scopes every video read, stream, and upload to its owner. Workflow payloads contain object keys only, and every task independently downloads its input into disposable scratch space.

## Setup

Requires Node 24+, npm, Docker, FFmpeg/ffprobe, and Hatchet Cloud or a self-hosted Hatchet server.

```bash
cd /Users/bek/dev/pr/video-processing-poc
npm install
cp .env.example .env
# Set HATCHET_CLIENT_TOKEN in .env
npm run infra:up
npm run db:init
npm run doctor
```

MinIO runs at `http://127.0.0.1:9000`, its console at `http://127.0.0.1:9001`, and the one-shot initializer creates a private bucket with development CORS rules. Credentials and the bucket can be overridden through the matching `S3_*` environment variables.

If those ports are already occupied, set `MINIO_API_PORT=9100`, `MINIO_CONSOLE_PORT=9101`, and `S3_ENDPOINT=http://127.0.0.1:9100` in `.env` before `npm run infra:up`.

Important configuration:

| Variable | Default |
| --- | --- |
| `PORT` | `4000` |
| `API_ORIGIN` | `http://127.0.0.1:4000` (Next.js only) |
| `DATABASE_PATH` | `./data/app.db` |
| `S3_ENDPOINT` | `http://127.0.0.1:9000` |
| `S3_REGION` | `us-east-1` |
| `S3_BUCKET` | `video-processing-poc` |
| `S3_FORCE_PATH_STYLE` | `true` |
| `S3_PRESIGNED_UPLOAD_TTL_SECONDS` | `600` |
| `WORKER_TEMP_DIR` | `./.worker-tmp` |
| `MAX_UPLOAD_BYTES` | `524288000` |
| `STATUS_CALLBACK_BASE_URL` | `http://127.0.0.1:4000` |
| `WORKER_CALLBACK_SECRET` | development-only value in `.env.example` |
| `SUPABASE_URL` | unset; enables Supabase auth when paired with the anon key |
| `SUPABASE_ANON_KEY` | unset; safe-to-expose Supabase public key |

For AWS S3, omit `S3_ENDPOINT`, use the appropriate region and credentials, and normally set `S3_FORCE_PATH_STYLE=false`. The storage constructor rejects missing bucket, region, or credentials, while `/health/ready` verifies both SQLite and bucket access.

## Authentication

Authentication is deliberately optional for local development:

- With `SUPABASE_URL` and `SUPABASE_ANON_KEY` unset, the app runs as one `local-development` user.
- With both configured, the dashboard presents email/password sign-in and sign-up. The browser authenticates directly with Supabase, then the API verifies the access token and establishes an HTTP-only, same-site session cookie.
- Videos are written with the authenticated Supabase user ID. List, detail, player status, and private HLS routes all enforce ownership. Cross-user lookups intentionally return 404.
- Migration `003_video_ownership.sql` assigns existing local records to the local development user and adds an indexed owner column.

Never use the Supabase service-role key in this application. Only the public anon key belongs in `SUPABASE_ANON_KEY`.

## Run the product

Start these in separate terminals after MinIO and the database are ready:

```bash
npm run worker
npm run api
npm run dev
```

Open `http://127.0.0.1:3000`. Next.js serves the public AI-video platform and rewrites its same-origin API and HLS requests to Fastify on port 4000. `/studio` contains the creator workspace. The product provides:

- drag-and-drop MP4 selection and direct-upload progress;
- live service health and video counts;
- an owner-scoped recent-video library;
- live queued, processing, completed, and failed states;
- a dedicated adaptive HLS player with pipeline progress.
- search and status filters for the video library;
- safe terminal-video deletion, including private object cleanup;
- a live system diagnostics page for the API, database, storage, and workflow configuration.
- a public landing page and searchable AI-video discovery feed;
- rich watch pages with views, likes, saves, comments, and sharing;
- creator profiles, publishing metadata and visibility controls;
- playlists, saved-video state, and an activity center;
- ten attributed, externally linked AI-film selections for inspiration.

The raw protocol remains available for API clients. With Supabase enabled, establish a session or supply a bearer token:

```bash
curl -sS -X POST http://127.0.0.1:4000/videos/uploads \
  -H 'content-type: application/json' \
  -d '{"filename":"sample.mp4","contentType":"video/mp4","sizeBytes":123456}'

curl -X PUT '<upload.url from response>' \
  -H 'content-type: video/mp4' --upload-file ./input/sample.mp4

curl -X POST http://127.0.0.1:4000/videos/<videoId>/upload-complete
curl http://127.0.0.1:4000/videos/<videoId>
```

The declared size must exactly match the uploaded object's size. Confirmation is idempotent and concurrent confirmations coalesce to one Hatchet submission. The previous multipart `POST /videos` upload is intentionally removed; clients must use the presigned flow.

Run the reusable end-to-end smoke test while the API, worker, Next.js, and MinIO are running:

```bash
npm run e2e:local -- input/sample.mp4
```

It creates a presigned upload, transfers the source, submits the Hatchet workflow, polls through processing, and verifies the published HLS manifest before printing the player URL.

Other API routes are `GET /videos`, `GET /streams/{videoId}/master.m3u8`, `GET /auth/me`, `GET /health/live`, and `GET /health/ready`. The React routes are `/` and `/player/[id]`.

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

Migration `002_object_storage.sql` adds source/output keys, upload lifecycle, expiry, ETag, and actual/declared size fields. Migration `003_video_ownership.sql` adds user ownership. Existing migrations remain immutable. New records never use persistent local media paths; older Phase 2 rows retain their local paths for legacy reconciliation.

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
npm run verify
npm audit
npm run db:init
```

The automated tests use fake object storage and temporary databases/directories. They cover Supabase session handling, cross-user isolation and deletion, direct-upload validation and idempotency, private HLS allowlisting, storage readiness, independent worker scratch, bounded staged uploads, master-last publication, reconciliation, cleanup, terminal transitions, and playable FFmpeg output.

To prove filesystem separation, start API and worker with distinct media and scratch directories; only status callbacks and object storage connect them:

```bash
UPLOAD_DIR=/tmp/api-unused OUTPUT_DIR=/tmp/api-unused-output npm run api
WORKER_TEMP_DIR=/tmp/video-worker-scratch UPLOAD_DIR=/tmp/worker-unused OUTPUT_DIR=/tmp/worker-unused-output npm run worker
```

For the retry demonstration, start the API with `FORCE_720P_FAILURE_ONCE=true`; the workflow intentionally fails the first 720p attempt and succeeds on retry without rerunning completed parents.

## Limits

- SQLite is still a single-node API persistence choice, although workers do not access it or share media directories.
- The FFmpeg semaphore is per worker process, not distributed.
- Stronger content inspection, object lifecycle policies, multipart-resume UX, CDN delivery, and distributed admission control remain future work.
- The frontend and Fastify API deploy as separate processes; a Vercel deployment would host Next.js while the API, worker, SQLite replacement, and object storage require persistent infrastructure.
- A crash after Hatchet accepts a run but before the API records its run ID remains ambiguous; reconciliation deliberately does not guess through it.

## Delivery history

The Git history intentionally demonstrates product evolution rather than one large import:

1. Phase 1 established the Hatchet/FFmpeg DAG and retry behavior.
2. Phase 2 added the Fastify API, SQLite status projection, safe HLS proxy, and reconciliation.
3. Phase 3 removed shared-media filesystem coupling with S3-compatible storage, direct uploads, isolated scratch space, staging publication, and cleanup.
4. The product layer added Supabase identity, per-user authorization, a complete upload workspace, processing UX, and polished playback.
5. The frontend migration separated the product into a Next.js/React application and a focused Fastify API, with local shadcn/ui-style components and same-origin proxying.

Run `git log --oneline --reverse` to walk through the implementation story.
