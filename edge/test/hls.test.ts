import { describe, expect, it } from "vitest";
import { PlaylistError, parseMasterPlaylist, parseMediaPlaylist } from "../src/publisher/hls.js";
import { MASTER, mediaPlaylist } from "./support/fixtures.js";

describe("master playlists", () => {
  it("reads the variants the pipeline writes", () => {
    expect(parseMasterPlaylist(MASTER).variants).toEqual([
      { uri: "360p/index.m3u8", bandwidth: 985_600, width: 640, height: 360 },
      { uri: "720p/index.m3u8", bandwidth: 3_220_800, width: 1280, height: 720 },
    ]);
  });

  it("reads quoted attributes that contain commas, and CRLF line endings", () => {
    const text = "#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1.64001f,mp4a.40.2\",RESOLUTION=640x360\r\n360p/index.m3u8\r\n";
    expect(parseMasterPlaylist(text).variants).toHaveLength(1);
  });

  it.each([
    ["no header", "#EXT-X-VERSION:3\n"],
    ["no variants", "#EXTM3U\n"],
    ["a variant outside the release", MASTER.replace("360p/index.m3u8", "../other/index.m3u8")],
    ["an absolute variant URL", MASTER.replace("360p/index.m3u8", "https://example.com/360p/index.m3u8")],
    ["a variant listed twice", MASTER.replace("720p/index.m3u8", "360p/index.m3u8")],
    ["a variant without a resolution", MASTER.replace(",RESOLUTION=640x360", "")],
    ["a variant without a bandwidth", MASTER.replace("BANDWIDTH=985600,", "")],
    ["a stream tag without a playlist", "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\n"],
    ["a playlist without a stream tag", "#EXTM3U\n360p/index.m3u8\n"],
    // A tag that points at another asset would let an unvalidated file into a release.
    ["an alternate rendition", `${MASTER}#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio/index.m3u8"\n`],
    ["an I-frame playlist", `${MASTER}#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframes.m3u8"\n`],
    ["a session key", `${MASTER}#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://example.com/key"\n`],
  ])("rejects %s", (_name, text) => { expect(() => parseMasterPlaylist(text)).toThrow(PlaylistError); });
});

describe("media playlists", () => {
  it("reads segments and their total duration", () => {
    const playlist = parseMediaPlaylist(mediaPlaylist(3), "360p/index.m3u8");
    expect(playlist.segments.map((segment) => segment.uri)).toEqual(["segment-000.ts", "segment-001.ts", "segment-002.ts"]);
    expect(playlist.durationSeconds).toBe(10);
    expect(playlist.targetDuration).toBe(4);
  });

  it.each([
    ["an unfinished playlist", mediaPlaylist(2).replace("#EXT-X-ENDLIST\n", "")],
    ["a live playlist", mediaPlaylist(2).replace("VOD", "EVENT")],
    ["no target duration", mediaPlaylist(2).replace("#EXT-X-TARGETDURATION:4\n", "")],
    ["no segments", "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-ENDLIST\n"],
    ["a segment in another directory", mediaPlaylist(2).replace("segment-001.ts", "../720p/segment-001.ts")],
    ["a segment on another host", mediaPlaylist(2).replace("segment-001.ts", "https://example.com/segment-001.ts")],
    ["a segment with a query string", mediaPlaylist(2).replace("segment-001.ts", "segment-001.ts?token=1")],
    ["a segment listed twice", mediaPlaylist(2).replace("segment-001.ts", "segment-000.ts")],
    ["a segment without a duration", mediaPlaylist(2).replace("#EXTINF:2.000000,\n", "")],
    ["a segment longer than the target duration", mediaPlaylist(2).replace("#EXTINF:4.000000,", "#EXTINF:9.000000,")],
    ["content after the end tag", `${mediaPlaylist(2)}#EXTINF:4.000000,\nsegment-009.ts\n`],
    ["an encryption key", mediaPlaylist(2).replace("#EXT-X-ENDLIST", "#EXT-X-KEY:METHOD=AES-128,URI=\"https://example.com/key\"\n#EXT-X-ENDLIST")],
    ["an initialization segment", mediaPlaylist(2).replace("#EXT-X-ENDLIST", "#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-ENDLIST")],
    ["a byte-range segment", mediaPlaylist(2).replace("#EXT-X-ENDLIST", "#EXT-X-BYTERANGE:100@0\n#EXT-X-ENDLIST")],
  ])("rejects %s", (_name, text) => { expect(() => parseMediaPlaylist(text, "360p/index.m3u8")).toThrow(PlaylistError); });
});

describe("a player must not be able to read a playlist differently from the validator", () => {
  // hls.js and other players end a line at a lone CR, and JavaScript regular expressions also at U+2028 and U+2029.
  // Text the validator took for one harmless line could then be a tag or a segment to the player.
  const KEY = '#EXT-X-KEY:METHOD=AES-128,URI="https://attacker.example/key"', SEGMENT = "#EXTINF:4.0,\rhttps://attacker.example/unvalidated.ts";
  const media = (injected: string) => mediaPlaylist(2).replace("#EXT-X-ENDLIST", `${injected}\n#EXT-X-ENDLIST`);
  const master = (injected: string) => MASTER.replace("#EXT-X-VERSION:3", injected);

  it.each([
    ["a tag hidden behind a lone carriage return in a comment", media(`# note\r${KEY}\r${SEGMENT}`)],
    ["a tag hidden behind a lone carriage return in a tag value", mediaPlaylist(2).replace("#EXT-X-VERSION:6", `#EXT-X-VERSION:6\r${SEGMENT}`)],
    ["a tag hidden behind U+2028", media(`# note\u2028#EXT-X-MAP:URI="https://attacker.example/init.mp4"`)],
    ["a tag hidden behind U+2029", media(`# note\u2029${KEY}`)],
    ["a tag hidden behind a next-line character", media(`# note\u0085${KEY}`)],
    ["a tag hidden behind a vertical tab or form feed", media(`# note\u000b${KEY}\u000c${KEY}`)],
    ["a comment", media("# just a note")],
    ["a lowercase tag", media('#ext-x-key:METHOD=AES-128,URI="https://attacker.example/key"')],
    ["an indented tag", media(` ${KEY}`)],
    ["a tab-indented segment", mediaPlaylist(2).replace("segment-001.ts", "\tsegment-001.ts")],
    ["a trailing space after a segment", mediaPlaylist(2).replace("segment-001.ts", "segment-001.ts ")],
    ["a byte order mark", `\ufeff${mediaPlaylist(2)}`],
    ["a NUL byte", mediaPlaylist(2).replace("segment-001.ts", "segment-001.ts\u0000")],
    ["a non-ASCII segment name", mediaPlaylist(2).replace("segment-001.ts", "segm\u00e9nt-001.ts")],
    ["a segment title", mediaPlaylist(2).replace("#EXTINF:2.000000,", "#EXTINF:2.000000,https://attacker.example/x.ts")],
    ["a version that is not a number", mediaPlaylist(2).replace("#EXT-X-VERSION:6", "#EXT-X-VERSION:6,URI=x")],
    ["a media sequence that is not a number", mediaPlaylist(2).replace("#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-MEDIA-SEQUENCE:0 #EXT-X-KEY")],
    ["an end tag with a value", mediaPlaylist(2).replace("#EXT-X-ENDLIST", "#EXT-X-ENDLIST:1")],
    ["a header with a value", mediaPlaylist(2).replace("#EXTM3U", "#EXTM3U:1")],
    ["a second header", media("#EXTM3U")],
    ["a zero-length segment", mediaPlaylist(2).replace("#EXTINF:2.000000,", "#EXTINF:0,")],
  ])("media playlist: rejects %s", (_name, text) => { expect(() => parseMediaPlaylist(text, "360p/index.m3u8")).toThrow(PlaylistError); });

  it.each([
    ["a variant hidden behind a lone carriage return", master("#EXT-X-VERSION:3\r#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\rhttps://attacker.example/other.m3u8")],
    ["a variant hidden behind U+2028", master("#EXT-X-VERSION:3\u2028#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\u2028https://attacker.example/other.m3u8")],
    ["a comment", master("#EXT-X-VERSION:3\n# note")],
    ["an audio group reference", MASTER.replace("RESOLUTION=640x360", 'RESOLUTION=640x360,AUDIO="aac"')],
    ["a subtitles group reference", MASTER.replace("RESOLUTION=640x360", 'RESOLUTION=640x360,SUBTITLES="subs"')],
    ["an attribute given twice", MASTER.replace("RESOLUTION=640x360", "RESOLUTION=640x360,BANDWIDTH=1")],
    ["an unquoted attribute with a quote in it", MASTER.replace("BANDWIDTH=985600", 'BANDWIDTH=98"5600')],
    ["a stream tag without attributes", MASTER.replace("#EXT-X-STREAM-INF:BANDWIDTH=985600,RESOLUTION=640x360", "#EXT-X-STREAM-INF:")],
    ["content steering", `${MASTER}#EXT-X-CONTENT-STEERING:SERVER-URI="https://attacker.example/steer"\n`],
    ["session data", `${MASTER}#EXT-X-SESSION-DATA:DATA-ID="x",URI="https://attacker.example/data.json"\n`],
  ])("master playlist: rejects %s", (_name, text) => { expect(() => parseMasterPlaylist(text)).toThrow(PlaylistError); });

  it("still reads what the pipeline writes, with LF or CRLF", () => {
    expect(parseMediaPlaylist(mediaPlaylist(3), "360p/index.m3u8").segments).toHaveLength(3);
    expect(parseMediaPlaylist(mediaPlaylist(3).replaceAll("\n", "\r\n"), "360p/index.m3u8").segments).toHaveLength(3);
    expect(parseMasterPlaylist(MASTER.replaceAll("\n", "\r\n")).variants).toHaveLength(2);
    expect(parseMasterPlaylist(MASTER.replace("RESOLUTION=640x360", 'RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",FRAME-RATE=30.000,AVERAGE-BANDWIDTH=900000')).variants).toHaveLength(2);
  });
});
