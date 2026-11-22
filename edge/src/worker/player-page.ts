/**
 * The demo player page. It is static: which release plays is decided in the browser from current.json, so the page
 * itself never changes with a promotion or a rollback.
 *
 * Playback uses hls.js, the engine under the application's Video.js player, pinned to the same version and loaded
 * from jsDelivr with a Subresource Integrity hash. A test checks the hash against the hls.js package in
 * package-lock.json, so the page can only ever run that exact file.
 */
import { NO_STORE } from "../shared/contract";

export const HLS_JS_VERSION = "1.7.3";
export const HLS_JS_URL = `https://cdn.jsdelivr.net/npm/hls.js@${HLS_JS_VERSION}/dist/hls.light.min.js`;
export const HLS_JS_INTEGRITY = "sha384-y8wQxRLtNclrHbMBLBLTEkgUrdFu6uWzZiobE1wBE09nt2wHIZlBPvPepdZU4+MM";

const STYLE = `
:root { color-scheme: dark; --bg: #0c0e12; --panel: #151920; --line: #262c37; --text: #e8ebf0; --muted: #98a2b3; --accent: #f2b53f; --hit: #4ade80; --miss: #fbbf24; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header, main { max-width: 1120px; margin: 0 auto; padding: 0 20px; }
header { display: flex; align-items: center; gap: 12px; padding-top: 22px; padding-bottom: 14px; }
h1 { font-size: 18px; margin: 0; font-weight: 650; letter-spacing: .2px; }
h2 { font-size: 12px; margin: 0 0 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--accent); color: var(--accent); text-transform: uppercase; letter-spacing: .08em; }
.lede { margin: 0 0 18px; color: var(--muted); max-width: 70ch; }
.layout { display: grid; grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr); gap: 20px; align-items: start; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
#player { display: block; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 8px; }
.card { position: relative; display: block; width: 100%; padding: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #000; cursor: pointer; aspect-ratio: 16 / 9; color: inherit; font: inherit; }
.card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.card img, .card video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.card video { opacity: 0; transition: opacity .15s ease; }
.card.is-previewing video { opacity: 1; }
.card .hint { position: absolute; left: 8px; bottom: 8px; font-size: 12px; padding: 2px 8px; border-radius: 6px; background: rgba(0, 0, 0, .7); }
.card .length { position: absolute; right: 8px; bottom: 8px; font-size: 12px; padding: 2px 6px; border-radius: 6px; background: rgba(0, 0, 0, .7); font-variant-numeric: tabular-nums; }
dl { margin: 14px 0 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
#message { margin: 0 0 16px; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--miss); color: var(--miss); }
.log { margin: 20px 0 40px; }
.scroll { max-height: 300px; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
th, td { text-align: left; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 500; position: sticky; top: 0; background: var(--panel); }
tr[data-cache="HIT"] td:nth-child(4) { color: var(--hit); }
tr[data-cache="MISS"] td:nth-child(4) { color: var(--miss); }
tr[data-cache="BROWSER"] td:nth-child(4) { color: var(--muted); }
.note { margin: 10px 0 0; color: var(--muted); font-size: 12.5px; }
@media (max-width: 820px) { .layout { grid-template-columns: minmax(0, 1fr); } }
`;

const SCRIPT = `
(() => {
  "use strict";
  const RELEASE_ID = /^[a-z0-9]{1,16}-[0-9a-f]{16}$/;
  const $ = (id) => document.getElementById(id);
  const started = performance.now();
  const say = (text) => { $("message").textContent = text; $("message").hidden = !text; };
  const seconds = (value) => Math.floor(value / 60) + ":" + String(Math.floor(value % 60)).padStart(2, "0");

  // One row per request, so a first load (MISS) and a repeat (HIT) can be told apart at a glance.
  const record = (file, status, cache, colo, bytes) => {
    const row = $("requests").insertRow();
    const cells = [((performance.now() - started) / 1000).toFixed(2) + " s", file, status ? String(status) : "-", cache || "-", bytes ? String(bytes) : "-"];
    for (const cell of cells) row.insertCell().textContent = cell;
    if (cache) row.dataset.cache = cache;
    if (colo) $("colo").textContent = colo;
    // Keep the newest row in view inside the table's own scroll area, without moving the page.
    $("log").scrollTop = $("log").scrollHeight;
    return row;
  };
  // A response answered by this browser's own cache never reached the edge, so the headers stored with it say nothing about the edge now.
  const fromBrowserCache = (url) => {
    const entries = performance.getEntriesByName(url, "resource"), last = entries[entries.length - 1];
    return Boolean(last && last.transferSize === 0 && last.decodedBodySize > 0);
  };
  const header = (details, name) => {
    try {
      if (details && typeof details.getResponseHeader === "function") return details.getResponseHeader(name);
      if (details && details.headers) return details.headers.get(name);
    } catch (error) { /* A header that cannot be read is simply not shown. */ }
    return null;
  };
  const report = (file, url, details, bytes) => {
    const row = record(file, details && details.status, header(details, "x-frameflow-cache"), header(details, "x-frameflow-colo"), bytes);
    // The timing entry for a request is added just after the request completes.
    setTimeout(() => { if (fromBrowserCache(url)) { row.cells[3].textContent = "BROWSER"; row.dataset.cache = "BROWSER"; } }, 100);
  };

  async function start() {
    const response = await fetch("current.json", { cache: "no-store" });
    record("current.json", response.status, response.headers.get("x-frameflow-cache"), response.headers.get("x-frameflow-colo"), 0);
    if (response.status === 404) { say("No release is active yet."); return; }
    if (!response.ok) throw new Error("current.json answered " + response.status);
    const current = await response.json();

    // ?release=<id> plays one specific version, which is how an older release is shown to still be there after a rollback.
    const asked = new URLSearchParams(location.search).get("release");
    const release = asked && RELEASE_ID.test(asked) ? asked : current.release;
    const base = "releases/" + release + "/";
    const short = (url) => { const at = url.indexOf(base); return at === -1 ? url : url.slice(at + base.length); };
    $("release").textContent = release === current.release ? release : release + " (chosen in the URL)";
    $("active").textContent = current.release + ", change " + current.sequence;
    $("updated").textContent = current.updatedAt;
    $("length").textContent = seconds(current.durationSeconds);

    const video = $("player");
    video.poster = base + "thumbnail.jpg";
    const source = base + "master.m3u8";
    if (window.Hls && window.Hls.isSupported()) {
      const Hls = window.Hls, hls = new Hls({ enableWorker: true });
      hls.on(Hls.Events.MANIFEST_LOADED, (event, data) => report("master.m3u8", data.url, data.networkDetails, data.stats && data.stats.total));
      hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => { $("renditions").textContent = data.levels.map((level) => level.height + "p").join(", "); });
      hls.on(Hls.Events.LEVEL_LOADED, (event, data) => report(short(data.details.url), data.details.url, data.networkDetails, data.stats && data.stats.total));
      hls.on(Hls.Events.FRAG_LOADED, (event, data) => report(short(data.frag.url), data.frag.url, data.networkDetails, data.frag.stats && data.frag.stats.total));
      hls.on(Hls.Events.ERROR, (event, data) => { if (data.fatal) say("Playback stopped: " + data.details + "."); });
      hls.loadSource(source);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = source;
    } else {
      say("This browser cannot play HLS.");
    }

    // The thumbnail is what the card shows at rest. The muted preview clip plays while the pointer is over it.
    const card = $("card"), preview = $("preview");
    $("thumbnail").src = base + "thumbnail.jpg";
    let previewing = false;
    const stopPreview = () => { previewing = false; card.classList.remove("is-previewing"); preview.pause(); };
    const playPreview = () => {
      if (previewing) return;
      previewing = true;
      if (!preview.getAttribute("src")) preview.src = base + "preview.mp4";
      preview.currentTime = 0;
      card.classList.add("is-previewing");
      const playing = preview.play();
      if (playing) playing.catch(stopPreview);
    };
    card.addEventListener("pointerenter", (event) => { if (event.pointerType !== "touch") playPreview(); });
    card.addEventListener("pointerleave", (event) => { if (event.pointerType !== "touch") stopPreview(); });
    card.addEventListener("focus", playPreview);
    card.addEventListener("blur", stopPreview);
    card.addEventListener("click", () => {
      // Without a hovering pointer, a tap toggles the preview. With one, a click starts the full video.
      if (window.matchMedia("(hover: none)").matches) { if (previewing) stopPreview(); else playPreview(); return; }
      stopPreview();
      video.scrollIntoView({ block: "center", behavior: "smooth" });
      const playing = video.play();
      if (playing) playing.catch(() => {});
    });

    // The image and the preview are loaded by the browser itself, so their rows come from resource timing, which has no response headers.
    if (window.PerformanceObserver) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (/\\/(thumbnail\\.jpg|preview\\.mp4)$/.test(entry.name)) record(short(entry.name), entry.responseStatus, entry.transferSize === 0 && entry.decodedBodySize > 0 ? "BROWSER" : null, null, entry.transferSize);
      }).observe({ type: "resource", buffered: true });
    }
  }

  start().catch((error) => say("The demo could not start: " + (error && error.message ? error.message : error)));
})();
`;

function page(environment: string): string {
  const label = environment.replace(/[^a-z0-9 -]/gi, "").slice(0, 24) || "staging";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Frameflow public demo</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>Frameflow public demo</h1>
  <span class="badge">${label}</span>
</header>
<main>
  <p class="lede">One owned sample, an FFmpeg test pattern, delivered as adaptive HLS by a Cloudflare Worker in front of an R2 bucket. Every release is immutable. This page plays whichever release is active.</p>
  <p id="message" role="status" hidden></p>
  <div class="layout">
    <section class="panel" aria-label="Player">
      <video id="player" controls playsinline preload="metadata"></video>
    </section>
    <section class="panel" aria-label="Thumbnail and preview">
      <h2>Thumbnail and hover preview</h2>
      <button class="card" id="card" type="button" aria-label="Play the sample. Hover or focus to preview it.">
        <img id="thumbnail" alt="Thumbnail of the sample video">
        <video id="preview" muted loop playsinline preload="none" tabindex="-1" aria-hidden="true"></video>
        <span class="hint">Hover to preview</span>
        <span class="length" id="length"></span>
      </button>
      <dl>
        <dt>Playing</dt><dd id="release">-</dd>
        <dt>Active</dt><dd id="active">-</dd>
        <dt>Updated</dt><dd id="updated">-</dd>
        <dt>Renditions</dt><dd id="renditions">-</dd>
        <dt>Edge location</dt><dd id="colo">-</dd>
      </dl>
    </section>
  </div>
  <section class="panel log" aria-label="Delivery">
    <h2>Delivery</h2>
    <div class="scroll" id="log">
      <table>
        <thead><tr><th>Time</th><th>File</th><th>Status</th><th>Edge cache</th><th>Bytes</th></tr></thead>
        <tbody id="requests"></tbody>
      </table>
    </div>
    <p class="note">MISS: read from the bucket and stored at this edge location. HIT: served from this location's cache. BYPASS: never cached. BROWSER: this browser's own cache answered, so the request did not reach the edge.</p>
  </section>
</main>
<script src="${HLS_JS_URL}" integrity="${HLS_JS_INTEGRITY}" crossorigin="anonymous"></script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

async function sourceHash(source: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)));
  return `'sha256-${btoa(String.fromCharCode(...digest))}'`;
}

/**
 * Hashes of the two inline blocks. The policy admits those, the pinned hls.js file, and nothing else. The finished
 * string is kept for the life of the isolate. The promise is not: a promise must not be shared between requests.
 */
let policy: string | undefined;
async function contentSecurityPolicy(): Promise<string> {
  if (policy === undefined) {
    const [script, style] = await Promise.all([sourceHash(SCRIPT), sourceHash(STYLE)]);
    policy = [
      "default-src 'none'", `script-src ${script} ${HLS_JS_URL}`, `style-src ${style}`, "img-src 'self'", "media-src 'self' blob:",
      "connect-src 'self'", "worker-src blob:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ].join("; ");
  }
  return policy;
}

export async function playerPage(environment: string): Promise<Response> {
  return new Response(page(environment), {
    headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": NO_STORE, "content-security-policy": await contentSecurityPolicy(),
      "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
    },
  });
}
