/**
 * A deliberately narrow HLS reader. It accepts exactly what Frameflow's FFmpeg pipeline writes (a master playlist of
 * variant streams, and VOD media playlists of MPEG-TS segments) and rejects everything else.
 *
 * It has to fail closed, because a player is a second parser of the same text. Anything this reader skipped or read
 * differently could be an asset a player fetches that nobody validated. So there is no "ignore": every line must be
 * one this file knows, in plain ASCII, ended by LF or CRLF, with a value in the expected form. Comments, unknown tags
 * and unusual line breaks all fail the release.
 */

export class PlaylistError extends Error {
  override name = "PlaylistError";
}

export type MasterVariant = { uri: string; bandwidth: number; width: number; height: number };
export type MasterPlaylist = { variants: MasterVariant[] };
export type MediaSegment = { uri: string; durationSeconds: number };
export type MediaPlaylist = { targetDuration: number; segments: MediaSegment[]; durationSeconds: number };

const VARIANT_URI = /^[0-9]{3,4}p\/index\.m3u8$/;
const SEGMENT_URI = /^segment-[0-9]{3,6}\.ts$/;
const WHOLE_NUMBER = /^[0-9]{1,12}$/;

/** Each tag a playlist may use, and the exact form its value must take. null means the tag takes no value. */
type TagRules = ReadonlyMap<string, RegExp | null>;
const MASTER_TAGS: TagRules = new Map([
  ["EXTM3U", null], ["EXT-X-VERSION", /^[0-9]{1,2}$/], ["EXT-X-INDEPENDENT-SEGMENTS", null], ["EXT-X-STREAM-INF", /^.+$/],
]);
const MEDIA_TAGS: TagRules = new Map([
  ["EXTM3U", null], ["EXT-X-VERSION", /^[0-9]{1,2}$/], ["EXT-X-TARGETDURATION", WHOLE_NUMBER], ["EXT-X-MEDIA-SEQUENCE", WHOLE_NUMBER],
  ["EXT-X-PLAYLIST-TYPE", /^VOD$/], ["EXT-X-INDEPENDENT-SEGMENTS", null], ["EXTINF", /^[0-9]{1,6}(?:\.[0-9]{1,9})?,?$/], ["EXT-X-ENDLIST", null],
]);
/** Attributes of a variant stream that describe it. Any other attribute would point at a rendition group or another playlist. */
const STREAM_ATTRIBUTES = new Set(["BANDWIDTH", "AVERAGE-BANDWIDTH", "RESOLUTION", "CODECS", "FRAME-RATE"]);

type Line = { kind: "tag"; name: string; value: string } | { kind: "uri"; value: string };

function readLines(text: string, name: string, rules: TagRules): Line[] {
  // Players split lines on more than LF: a lone CR, and in JavaScript regular expressions U+2028 and U+2029. Text
  // that this reader saw as one line and a player saw as several could hide a tag, so only plain ASCII gets through.
  if (!/^[\x20-\x7e\r\n]*$/.test(text)) throw new PlaylistError(`${name} contains a character other than printable ASCII and line breaks`);
  const raw = text.split(/\r\n|\n/);
  if (raw.some((line) => line.includes("\r"))) throw new PlaylistError(`${name} contains a carriage return that is not part of a line break`);

  const lines: Line[] = [];
  for (const line of raw) {
    if (line === "") continue;
    if (line !== line.trim()) throw new PlaylistError(`${name} has a line with leading or trailing spaces`);
    if (!line.startsWith("#")) { lines.push({ kind: "uri", value: line }); continue; }
    const colon = line.indexOf(":"), tag = line.slice(1, colon === -1 ? undefined : colon), value = colon === -1 ? null : line.slice(colon + 1);
    // A comment is as unknown as any other line, and is refused like one.
    if (!rules.has(tag)) throw new PlaylistError(`${name} has an unsupported line: ${line.slice(0, 48)}`);
    const form = rules.get(tag)!;
    if (form === null ? value !== null : value === null || !form.test(value)) throw new PlaylistError(`${name} has a malformed #${tag}`);
    lines.push({ kind: "tag", name: tag, value: value ?? "" });
  }
  const first = lines[0];
  if (!first || first.kind !== "tag" || first.name !== "EXTM3U") throw new PlaylistError(`${name} does not start with #EXTM3U`);
  if (lines.filter((line) => line.kind === "tag" && line.name === "EXTM3U").length !== 1) throw new PlaylistError(`${name} repeats #EXTM3U`);
  return lines;
}

/** Attribute lists are comma-separated, but a quoted value may itself contain commas. */
function parseStreamAttributes(value: string, name: string): Map<string, string> {
  const attributes = new Map<string, string>(), pattern = /([A-Z0-9-]+)=("[^"]*"|[^",]*)(,|$)/y;
  let position = 0;
  while (position < value.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(value);
    if (!match) throw new PlaylistError(`${name} has a malformed attribute list`);
    if (!STREAM_ATTRIBUTES.has(match[1]!) || attributes.has(match[1]!)) throw new PlaylistError(`${name} has an unsupported or repeated attribute ${match[1]}`);
    attributes.set(match[1]!, match[2]!.replace(/^"|"$/g, ""));
    position = pattern.lastIndex;
  }
  return attributes;
}

function positive(value: string | undefined, what: string): number {
  if (value === undefined || !WHOLE_NUMBER.test(value) || Number(value) <= 0) throw new PlaylistError(`${what} must be a positive integer`);
  return Number(value);
}

export function parseMasterPlaylist(text: string, name = "master.m3u8"): MasterPlaylist {
  const lines = readLines(text, name, MASTER_TAGS), variants: MasterVariant[] = [], seen = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.kind === "uri") throw new PlaylistError(`${name} lists ${line.value} without #EXT-X-STREAM-INF`);
    if (line.name !== "EXT-X-STREAM-INF") continue;
    const next = lines[++index];
    if (!next || next.kind !== "uri") throw new PlaylistError(`${name} has #EXT-X-STREAM-INF without a playlist`);
    if (!VARIANT_URI.test(next.value)) throw new PlaylistError(`${name} references ${next.value}, which is not a rendition playlist inside the release`);
    if (seen.has(next.value)) throw new PlaylistError(`${name} lists ${next.value} twice`);
    seen.add(next.value);
    const attributes = parseStreamAttributes(line.value, name), resolution = /^([0-9]{2,5})x([0-9]{2,5})$/.exec(attributes.get("RESOLUTION") ?? "");
    if (!resolution) throw new PlaylistError(`${name} gives ${next.value} no RESOLUTION`);
    variants.push({ uri: next.value, bandwidth: positive(attributes.get("BANDWIDTH"), `${name} BANDWIDTH of ${next.value}`), width: Number(resolution[1]), height: Number(resolution[2]) });
  }
  if (variants.length === 0) throw new PlaylistError(`${name} lists no variant streams`);
  return { variants };
}

export function parseMediaPlaylist(text: string, name: string): MediaPlaylist {
  const lines = readLines(text, name, MEDIA_TAGS), segments: MediaSegment[] = [], seen = new Set<string>();
  let targetDuration: number | undefined, ended = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.kind === "uri") throw new PlaylistError(`${name} lists ${line.value} without #EXTINF`);
    if (ended) throw new PlaylistError(`${name} continues after #EXT-X-ENDLIST`);
    if (line.name === "EXT-X-TARGETDURATION") targetDuration = positive(line.value, `${name} #EXT-X-TARGETDURATION`);
    else if (line.name === "EXT-X-ENDLIST") ended = true;
    else if (line.name === "EXTINF") {
      const durationSeconds = Number(line.value.replace(/,$/, "")), next = lines[++index];
      if (!(durationSeconds > 0)) throw new PlaylistError(`${name} has a segment without a duration`);
      if (!next || next.kind !== "uri") throw new PlaylistError(`${name} has #EXTINF without a segment`);
      if (!SEGMENT_URI.test(next.value)) throw new PlaylistError(`${name} references ${next.value}, which is not a segment beside the playlist`);
      if (seen.has(next.value)) throw new PlaylistError(`${name} lists ${next.value} twice`);
      seen.add(next.value);
      segments.push({ uri: next.value, durationSeconds });
    }
  }
  if (!ended) throw new PlaylistError(`${name} has no #EXT-X-ENDLIST, so it is not a finished VOD playlist`);
  if (targetDuration === undefined) throw new PlaylistError(`${name} has no #EXT-X-TARGETDURATION`);
  if (segments.length === 0) throw new PlaylistError(`${name} lists no segments`);
  const longest = segments.find((segment) => Math.round(segment.durationSeconds) > targetDuration);
  if (longest) throw new PlaylistError(`${name} lists ${longest.uri} longer than its target duration`);
  return { targetDuration, segments, durationSeconds: segments.reduce((total, segment) => total + segment.durationSeconds, 0) };
}
