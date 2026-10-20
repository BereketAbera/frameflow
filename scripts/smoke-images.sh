#!/usr/bin/env bash
# Runs the web and backend images the way the deployment does: a read-only root filesystem, a tmpfs only where each
# role writes (as its emptyDirs and volumes will be), every capability dropped, no privilege escalation, and each
# image's own non-root user. Then it checks what the deployment relies on, for the API, the web server, the worker,
# reconcile and cleanup. It needs no Hatchet, no S3 and no Internet: the backend gets an S3 endpoint nothing listens on,
# and a Hatchet token that only parses, whose claims name engine addresses nothing listens on either. It removes every
# container and the network it creates.
#
#   scripts/smoke-images.sh <web-image> <backend-image>
#
# PLATFORM=linux/amd64 or PLATFORM=linux/arm64 runs that platform's images, and fails before anything runs if either is
# another. API_ORIGIN is the origin the web image was built with, by default the Dockerfile's http://frameflow-api:4000.
# The API container answers to that name on the smoke network, so /api/* through the web server reaches it.
# images.yml runs this on the images it builds and on each digest it pushes. Exits non-zero if any check fails.
set -euo pipefail

web_image="${1:?usage: scripts/smoke-images.sh <web-image> <backend-image>}"
backend_image="${2:?usage: scripts/smoke-images.sh <web-image> <backend-image>}"
API_ORIGIN="${API_ORIGIN:-http://frameflow-api:4000}"
origin_pattern='^http://([a-z0-9][a-z0-9.-]*):([0-9]+)$'
[[ "$API_ORIGIN" =~ $origin_pattern ]] || { echo "API_ORIGIN must look like http://<host>:<port>, got '$API_ORIGIN'" >&2; exit 2; }
api_host="${BASH_REMATCH[1]}" api_port="${BASH_REMATCH[2]}"
platform_pattern='^linux/(amd64|arm64)$'
if [[ -n "${PLATFORM:-}" ]]; then
  [[ "$PLATFORM" =~ $platform_pattern ]] || { echo "PLATFORM must be linux/amd64 or linux/arm64, got '$PLATFORM'" >&2; exit 2; }
  export DOCKER_DEFAULT_PLATFORM="$PLATFORM"
fi

run_id="frameflow-smoke-$$"
network="$run_id"
containers=()
network_created=no
cleanup() {
  local status=$?
  [[ "$status" -eq 0 || "${finished:-}" == yes ]] || printf 'smoke-images: stopped early with status %s, before its summary\n' "$status" >&2
  [[ ${#containers[@]} -eq 0 ]] || docker rm -f "${containers[@]}" >/dev/null 2>&1 || true
  [[ "$network_created" == no ]] || docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

failures=0
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; failures=$((failures + 1)); }
check() { # check <label> <actual> <expected>
  if [[ "$2" == "$3" ]]; then pass "$1: $2"; else fail "$1: got '$2', expected '$3'"; fi
}

for image in "$web_image" "$backend_image"; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull --quiet "$image" >/dev/null
  if [[ -n "${PLATFORM:-}" ]]; then
    actual="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")"
    [[ "$actual" == "$PLATFORM" ]] || { fail "$image is $actual, expected $PLATFORM"; exit 1; }
    pass "$image is $actual"
  fi
done

# A JWT the Hatchet SDK accepts: it decodes the claims and checks no signature. The value is never printed, and reaches each
# container through the environment rather than its command line.
b64url() { base64 | tr -d '\n=' | tr '/+' '_-'; }
HATCHET_CLIENT_TOKEN="$(printf '%s' '{"alg":"none","typ":"JWT"}' | b64url).$(printf '%s' \
  '{"sub":"00000000-0000-0000-0000-000000000000","grpc_broadcast_address":"127.0.0.1:7070","server_url":"http://127.0.0.1:8080"}' | b64url).c21va2U"
export HATCHET_CLIENT_TOKEN

docker network create "$network" >/dev/null
network_created=yes
hardened=(--pull never --read-only --cap-drop ALL --security-opt no-new-privileges --network "$network")
# Like Kubernetes emptyDirs: writable by any user. /tmp keeps its sticky bit.
backend_env=(--tmpfs /tmp:mode=1777 --tmpfs /data:mode=0777 --tmpfs /scratch:mode=0777
  -e DATABASE_PATH=/data/app.db -e WORKER_TEMP_DIR=/scratch -e HATCHET_CLIENT_TOKEN -e S3_ENDPOINT=http://127.0.0.1:9)

start() { # start <name> <container port> <docker run args...>: sets $base to the published port on 127.0.0.1
  local name="$1" port="$2"
  shift 2
  containers+=("$name")
  docker run -d --name "$name" "${hardened[@]}" -p "127.0.0.1::$port" "$@" >/dev/null
  base="http://127.0.0.1:$(docker port "$name" "$port/tcp" | head -n 1 | sed 's/.*://')"
}
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$base$1" || true; }
body() { curl -s -m 10 "$base$1" || true; }
wait_for() { # wait_for <container> <path> <seconds>: waits for 200 from a path
  local i=0
  until [[ "$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$base$2" || true)" == 200 ]]; do
    i=$((i + 1))
    if [[ $i -ge $3 ]]; then
      fail "$2 did not answer 200 within $3 s"
      docker logs "$1" 2>&1 | tail -n 30
      return 1
    fi
    sleep 1
  done
  pass "$2 answers 200 after about $i s"
}
wait_log() { # wait_log <container> <fixed string> <seconds>
  local i=0
  until docker logs "$1" 2>&1 | grep -Fq -- "$2"; do
    i=$((i + 1))
    if [[ $i -ge $3 ]]; then
      fail "$1 did not log '$2' within $3 s"
      docker logs "$1" 2>&1 | tail -n 30
      return 1
    fi
    sleep 1
  done
  pass "logged '$2' after about $i s"
}
as_user() { check "$1 runs as uid" "$(docker exec "$1" id -u 2>/dev/null || echo 'nothing: it is not running')" 1000; }
no_write_errors() {
  if docker logs "$1" 2>&1 | grep -Eqi 'EROFS|read-only file system|EACCES'; then fail "$1 logged a write error"; else pass "$1 logged no write error"; fi
}
stops() { # stops <container>: SIGTERM must end it well inside the default grace period
  local began=$SECONDS
  docker stop -t 10 "$1" >/dev/null
  if [[ $((SECONDS - began)) -lt 5 ]]; then pass "$1 stops on SIGTERM in $((SECONDS - began)) s"; else fail "$1 took $((SECONDS - began)) s to stop"; fi
}

printf '\n== backend API: %s\n' "$backend_image"
api="$run_id-api"
start "$api" "$api_port" --network-alias "$api_host" "${backend_env[@]}" -e HOST=0.0.0.0 -e PORT="$api_port" "$backend_image"
wait_for "$api" /health/live 90 || exit 1
check "GET /health/live" "$(body /health/live)" '{"status":"ok"}'
check "GET /health/ready with S3 unreachable" "$(code /health/ready)" 503
migrations="$(docker exec "$api" node -e '
  const files = require("node:fs").readdirSync("/app/migrations").filter((name) => name.endsWith(".sql")).length;
  const { DatabaseSync } = require("node:sqlite");
  const { applied } = new DatabaseSync(process.env.DATABASE_PATH, { readOnly: true }).prepare("SELECT count(*) AS applied FROM schema_migrations").get();
  console.log(`${applied} of ${files}`);' 2>&1 || true)"
migrations_pattern='^([1-9][0-9]*) of ([0-9]+)$'
if [[ "$migrations" =~ $migrations_pattern && "${BASH_REMATCH[1]}" == "${BASH_REMATCH[2]}" ]]; then
  pass "migrations applied: $migrations"
else
  fail "migrations applied: $migrations"
fi
if body /social/feed | grep -q '"featured":\[{'; then pass "GET /social/feed serves the seeded featured films"; else fail "GET /social/feed has no featured films"; fi
as_user "$api"
check "PID 1 in $api" "$(docker exec "$api" cat /proc/1/comm)" tini
check "tsx caches in /tmp" "$(docker exec "$api" sh -c 'ls -d /tmp/tsx-*')" /tmp/tsx-1000

printf '\n== web: %s\n' "$web_image"
web="$run_id-web"
start "$web" 3000 --tmpfs /tmp:mode=1777 --tmpfs /app/.next/cache:mode=0777 "$web_image"
wait_for "$web" / 90 || exit 1
check "GET / content type" "$(curl -s -o /dev/null -m 10 -w '%{content_type}' "$base/" | sed 's/;.*//')" text/html
html="$(body /)"
if grep -q '<title>Frameflow' <<<"$html"; then pass "GET / is the Frameflow page"; else fail "GET / has no Frameflow title"; fi
asset="$(grep -oE '/_next/static/[^"]+\.(js|css)' <<<"$html" | head -n 1 || true)"
if [[ -n "$asset" ]]; then check "GET $asset" "$(code "$asset")" 200; else fail "GET / links no /_next/static asset"; fi
check "GET /discover" "$(code /discover)" 200
check "GET /watch/smoke, rendered on request" "$(code /watch/smoke)" 200
rewrites="$(docker exec "$web" cat /app/.next/routes-manifest.json | { grep -Eo "\"destination\": *\"$API_ORIGIN/" || true; } | wc -l | tr -d ' ')"
if [[ "$rewrites" -ge 1 ]]; then pass "$rewrites rewrites point at $API_ORIGIN"; else fail "no rewrite points at $API_ORIGIN, so this image was built with another API_ORIGIN"; fi
check "GET /api/health/live, through the rewrite to the API" "$(code /api/health/live)" 200
check "GET /api/health/ready, through the rewrite to the API" "$(code /api/health/ready)" 503
as_user "$web"

printf '\n== worker: %s\n' "$backend_image"
worker="$run_id-worker"
containers+=("$worker")
# The stale directory stands for what a killed pod leaves in WORKER_TEMP_DIR. FRAMEFLOW_REGISTER_LEGACY_WORKFLOW=false is
# what a deployment sets, as the filesystem workflow needs a shared disk.
docker run -d --name "$worker" "${hardened[@]}" "${backend_env[@]}" -e FRAMEFLOW_REGISTER_LEGACY_WORKFLOW=false "$backend_image" \
  sh -c 'mkdir /scratch/encode-stale && exec node --import tsx src/worker.ts' >/dev/null
wait_log "$worker" "Removed 1 stale scratch directory from /scratch" 90 || true
# With modules loaded and the scratch directory clean, it registers its workflows with the engine the token names. The
# SDK's admin client makes that call over Connect and logs each failed attempt with the error's Connect code. It retries
# for about 13 s before the worker exits, so the checks below still find it running.
wait_log "$worker" "[ERROR/Admin] Error: [unavailable]" 60 || true
if docker logs "$worker" 2>&1 | grep -q 'ECONNREFUSED 127.0.0.1:7070'; then pass "the worker dialled the token's engine address"; else fail "the worker never dialled 127.0.0.1:7070"; fi
as_user "$worker"
no_write_errors "$worker"
docker rm -f "$worker" >/dev/null

printf '\n== reconcile and cleanup: %s\n' "$backend_image"
one_off() { docker run --rm "${hardened[@]}" "${backend_env[@]}" "$backend_image" node --import tsx "$@" 2>&1 || true; }
check "src/reconcile.ts on an empty database" "$(one_off src/reconcile.ts | tail -n 1)" "Reconciliation complete: inspected=0, repaired=0"
check "src/cleanup.ts on an empty database" "$(one_off src/cleanup.ts | tail -n 1)" "Planned: 0"

printf '\n== shutdown\n'
no_write_errors "$api"
no_write_errors "$web"
stops "$web"
stops "$api"

finished=yes
printf '\n'
if [[ "$failures" -gt 0 ]]; then
  printf '%s smoke check(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'All smoke checks passed for %s and %s\n' "$web_image" "$backend_image"
