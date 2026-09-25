#!/usr/bin/env bash
# Checks that the FFmpeg in a backend image can do what the worker asks of it: the libx264 and aac encoders, the hls
# muxer, and a 2-second 1280x720 test pattern with a tone, transcoded with the worker's 720p settings into an HLS
# playlist and segments that ffprobe then reads back. Each container runs as the image's own user, with a read-only
# root filesystem, no capabilities and only /tmp writable, and is removed when it exits.
#
#   scripts/check-ffmpeg-image.sh <image>
#
# PLATFORM=linux/amd64 or PLATFORM=linux/arm64 runs that platform's image, and fails before anything runs if the image
# is another. images.yml runs this on the images it builds and on each digest it pushes. Exits non-zero on any failure.
set -euo pipefail

image="${1:?usage: scripts/check-ffmpeg-image.sh <image>}"
platform_pattern='^linux/(amd64|arm64)$'
if [[ -n "${PLATFORM:-}" ]]; then
  [[ "$PLATFORM" =~ $platform_pattern ]] || { echo "PLATFORM must be linux/amd64 or linux/arm64, got '$PLATFORM'" >&2; exit 2; }
  export DOCKER_DEFAULT_PLATFORM="$PLATFORM"
fi

failures=0
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; failures=$((failures + 1)); }
in_image() { docker run --rm --pull never --read-only --tmpfs /tmp:mode=1777 --cap-drop ALL --security-opt no-new-privileges "$image" "$@"; }

docker image inspect "$image" >/dev/null 2>&1 || docker pull --quiet "$image" >/dev/null
printf '== ffmpeg in %s\n' "$image"
if [[ -n "${PLATFORM:-}" ]]; then
  actual="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")"
  [[ "$actual" == "$PLATFORM" ]] || { fail "image is $actual, expected $PLATFORM"; exit 1; }
  pass "image is $actual"
fi

version="$(in_image ffmpeg -hide_banner -version)"
pass "${version%%$'\n'*}"

encoders="$(in_image ffmpeg -hide_banner -encoders)"
# A row is "<flags> <name> <description>", and the first flag is V for video and A for audio.
for wanted in V:libx264 A:aac; do
  if awk -v kind="${wanted%%:*}" -v name="${wanted#*:}" '$2 == name && substr($1, 1, 1) == kind { found = 1 } END { exit !found }' <<<"$encoders"; then
    pass "encoder ${wanted#*:}"
  else
    fail "no ${wanted#*:} encoder"
  fi
done
muxers="$(in_image ffmpeg -hide_banner -muxers)"
if awk '$2 == "hls" && $1 ~ /E/ { found = 1 } END { exit !found }' <<<"$muxers"; then pass "muxer hls"; else fail "no hls muxer"; fi

# The worker's 720p arguments from src/services/ffmpeg.ts, with 1-second segments so that a 2-second clip makes several.
read -r -d '' transcode <<'SH' || true
set -eu
out=/tmp/hls
mkdir "$out"
ffmpeg -hide_banner -nostats -loglevel error \
  -f lavfi -i testsrc=size=1280x720:rate=30:duration=2 \
  -f lavfi -i sine=frequency=440:sample_rate=48000:duration=2 \
  -map 0:v:0 -map 1:a:0 \
  -vf 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2' \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 2800k -maxrate 2996k -bufsize 4200k \
  -force_key_frames 'expr:gte(t,n_forced*1)' -sc_threshold 0 \
  -c:a aac -b:a 128k -ac 2 \
  -f hls -hls_time 1 -hls_playlist_type vod -hls_flags independent_segments \
  -hls_segment_filename "$out/segment-%03d.ts" "$out/index.m3u8"
echo "playlist_bytes=$(wc -c <"$out/index.m3u8")"
echo "segments=$(find "$out" -name 'segment-*.ts' -size +0 | wc -l)"
echo "listed=$(grep -c '^segment-[0-9]*\.ts$' "$out/index.m3u8")"
echo "endlist=$(grep -c '^#EXT-X-ENDLIST$' "$out/index.m3u8")"
ffprobe -v error -show_entries stream=codec_name,width,height -of csv=p=0 "$out/index.m3u8" | sed 's/^/stream=/'
SH
if result="$(in_image sh -c "$transcode" 2>&1)"; then
  pass "transcoded testsrc 1280x720 + sine to HLS with libx264 and aac"
else
  fail "the transcode failed:"
  printf '%s\n' "$result"
  exit 1
fi
value() { sed -n "s/^$1=//p" <<<"$result" | tr -d ' '; }
playlist_bytes="$(value playlist_bytes)" segments="$(value segments)" listed="$(value listed)" endlist="$(value endlist)"
if [[ "${playlist_bytes:-0}" -gt 0 ]]; then pass "index.m3u8 has $playlist_bytes bytes"; else fail "index.m3u8 is missing or empty"; fi
if [[ "${segments:-0}" -ge 1 ]]; then pass "$segments non-empty .ts segments"; else fail "no .ts segment"; fi
if [[ "${listed:-x}" == "${segments:-y}" ]]; then pass "the playlist lists all $listed segments"; else fail "the playlist lists ${listed:-none} of ${segments:-0} segments"; fi
if [[ "${endlist:-0}" == 1 ]]; then pass "the playlist is a complete VOD playlist"; else fail "the playlist has no #EXT-X-ENDLIST"; fi
# ffprobe lists each stream once under the playlist's program and once more on its own.
streams="$(value stream | sed '/^$/d' | sort -u | tr '\n' ' ')"
if [[ "$streams" == "aac h264,1280,720 " ]]; then pass "ffprobe reads h264 1280x720 and aac"; else fail "ffprobe reads: ${streams:-nothing}"; fi

if [[ "$failures" -gt 0 ]]; then
  printf '%s check(s) failed for %s\n' "$failures" "$image" >&2
  exit 1
fi
printf 'All FFmpeg checks passed for %s\n' "$image"
