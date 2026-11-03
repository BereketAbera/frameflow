"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Hls from "hls.js";
import { AlertTriangle, ArrowLeft, Check, Copy, LoaderCircle, RotateCcw, Settings } from "lucide-react";
import { Brand } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Video = { id: string; originalFilename: string; status: string; sizeBytes?: number; createdAt: string; updatedAt?: string; processingStartedAt?: string; processingCompletedAt?: string; playbackUrl?: string; error?: { message: string } };

export function PlayerView({ id }: { id: string }) {
  const [data, setData] = useState<Video | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const [qualities, setQualities] = useState<{ height: number; index: number }[]>([]);
  const [quality, setQuality] = useState(-1);
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    async function load() {
      try {
        const response = await fetch(`/api/videos/${id}`);
        if (response.status === 401) return void (location.href = "/");
        if (response.status === 404) return active && setNotFound(true);
        if (!response.ok) throw new Error("Could not load this video.");
        const next = await response.json();
        if (!active) return;
        setData(next);
        if (!["completed", "failed"].includes(next.status)) timer = setTimeout(load, 1800);
      } catch (error) {
        if (active) setPlaybackError(error instanceof Error ? error.message : "Could not load this video.");
      }
    }
    load();
    return () => { active = false; clearTimeout(timer); };
  }, [id]);

  useEffect(() => {
    if (!data?.playbackUrl || !video.current) return;
    const element = video.current;
    setPlaybackError("");
    if (element.canPlayType("application/vnd.apple.mpegurl")) {
      element.src = data.playbackUrl;
      setQualities([]);
      return;
    }
    if (!Hls.isSupported()) return setPlaybackError("This browser cannot play HLS video.");
    const instance = new Hls({ enableWorker: true });
    hls.current = instance;
    instance.loadSource(data.playbackUrl);
    instance.attachMedia(element);
    instance.on(Hls.Events.MANIFEST_PARSED, (_, manifest) => setQualities(manifest.levels.map((level, index) => ({ height: level.height, index }))));
    instance.on(Hls.Events.ERROR, (_, event) => {
      if (event.fatal) setPlaybackError("Playback stopped because the adaptive stream could not be loaded.");
    });
    return () => { instance.destroy(); hls.current = null; };
  }, [data?.playbackUrl]);

  function selectQuality(next: number) {
    setQuality(next);
    if (hls.current) hls.current.currentLevel = next;
  }
  const stage = data?.status === "completed" ? 4 : data?.status === "processing" ? 2 : ["queued", "uploaded"].includes(data?.status || "") ? 1 : 0;
  const processingTime = data?.processingStartedAt && data.processingCompletedAt ? Math.max(0, Math.round((new Date(data.processingCompletedAt).getTime() - new Date(data.processingStartedAt).getTime()) / 1000)) : null;

  if (notFound) return <div className="grid min-h-screen place-items-center bg-[#10110e] p-6 text-center text-white"><div><AlertTriangle className="mx-auto mb-5 size-12 text-brand" /><h1 className="text-3xl font-bold">Video not found</h1><p className="mt-2 text-white/50">It may have been removed, or it belongs to another workspace.</p><Link href="/"><Button className="mt-6" variant="brand"><ArrowLeft />Back to workspace</Button></Link></div></div>;

  return <div className="min-h-screen bg-[#10110e] text-white">
    <header className="mx-auto flex h-19 w-[min(1120px,calc(100%-2rem))] items-center justify-between border-b border-white/10"><Brand inverse /><Link href="/" className="flex items-center gap-2 text-sm text-white/60 hover:text-white"><ArrowLeft className="size-4" />Back to workspace</Link></header>
    <main className="mx-auto w-[min(1120px,calc(100%-2rem))] py-12">
      <div className="mb-5 flex flex-col justify-between gap-5 md:flex-row md:items-end"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-brand">Video detail</p><h1 className="mt-3 max-w-3xl truncate text-4xl font-bold tracking-tight">{data?.originalFilename || "Loading video…"}</h1><p className="mt-1 text-sm text-white/50">{data ? `Uploaded ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(data.createdAt))}` : "Fetching workflow status"}</p></div><div className="flex items-center gap-2">{data?.status === "completed" && <><Link href={`/studio/edit/${id}`}><Button variant="outline" className="border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white"><Settings/>Publish settings</Button></Link><Button variant="outline" className="border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white" onClick={async () => { await navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy link"}</Button></>}<Badge status={data?.status}>{data?.status || "loading"}</Badge></div></div>
      <div className="relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl">{data?.status === "completed" ? <><video ref={video} controls playsInline className="size-full object-contain" />{qualities.length > 0 && <label className="absolute right-3 top-3 rounded-lg bg-black/70 px-3 py-2 text-xs text-white/70">Quality <select aria-label="Playback quality" value={quality} onChange={(event) => selectQuality(Number(event.target.value))} className="ml-2 bg-transparent text-white outline-none"><option value={-1}>Auto</option>{qualities.map((item) => <option value={item.index} key={item.index}>{item.height}p</option>)}</select></label>}{playbackError && <div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center"><div><AlertTriangle className="mx-auto mb-4 text-brand" /><p>{playbackError}</p><Button className="mt-5" variant="outline" onClick={() => location.reload()}><RotateCcw />Reload player</Button></div></div>}</> : <div className="grid size-full place-items-center text-center"><div>{data?.status === "failed" ? <span className="mx-auto mb-5 grid size-16 place-items-center rounded-2xl bg-red-500/10 text-2xl text-red-400">!</span> : <LoaderCircle className="mx-auto mb-5 size-12 animate-spin text-white/50" />}<h2 className="text-2xl font-semibold">{data?.status === "failed" ? "Processing failed" : data?.status === "processing" ? "Transcoding in parallel" : "Preparing your stream"}</h2><p className="mt-2 text-white/50">{data?.error?.message || playbackError || "Hatchet is coordinating the video pipeline."}</p></div></div>}</div>
      <div className="mt-5 grid overflow-hidden rounded-xl border border-white/10 md:grid-cols-4">{[["Upload", "Secure source transfer"], ["Queue", "Hatchet orchestration"], ["Transcode", "360p + 720p HLS"], ["Publish", "Private adaptive stream"]].map(([title, description], index) => <div key={title} className="border-b border-white/10 p-5 last:border-0 md:border-b-0 md:border-r md:last:border-r-0"><strong className={index < stage ? "text-xs uppercase tracking-wider text-emerald-400" : index === stage ? "text-xs uppercase tracking-wider text-blue-400" : "text-xs uppercase tracking-wider text-white/35"}>{String(index + 1).padStart(2, "0")} · {title}</strong><p className="mt-2 text-xs text-white/45">{description}</p></div>)}</div>
      <Card className="mt-8 border-white/10 bg-white/[.03] text-white"><CardContent className="grid gap-px p-0 md:grid-cols-4">{[["Video ID", id], ["Source size", data?.sizeBytes ? `${(data.sizeBytes / 1048576).toFixed(1)} MB` : "—"], ["Processing time", processingTime === null ? "—" : `${processingTime}s`], ["Status", data?.status || "loading"]].map(([label, value]) => <div className="p-5" key={label}><p className="text-xs uppercase tracking-wider text-white/35">{label}</p><p className="mt-2 truncate font-mono text-sm text-white/80">{value}</p></div>)}</CardContent></Card>
    </main>
  </div>;
}
