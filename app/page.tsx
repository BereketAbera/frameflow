"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Activity, ArrowUp, ChevronRight, Play, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { AuthGate, type AuthConfig } from "@/components/auth-gate";
import { Brand } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";

type User = { id: string; email?: string };
type Video = { id: string; originalFilename: string; status: string; sizeBytes?: number; createdAt: string; error?: { message: string } };
type Filter = "all" | "active" | "completed" | "failed";

const activeStatuses = new Set(["uploading", "uploaded", "queued", "processing"]);
const maxUploadBytes = 500 * 1024 * 1024;
const formatSize = (bytes?: number) => bytes ? `${(bytes / 1048576).toFixed(1)} MB` : "—";

export default function Workspace() {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadName, setUploadName] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/videos?limit=100");
      if (response.status === 401) return setUser(null);
      if (!response.ok) throw new Error("Could not load your video library.");
      setVideos((await response.json()).videos);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load your video library.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [authConfig, session] = await Promise.all([
          fetch("/api/auth/config").then((response) => {
            if (!response.ok) throw new Error("Could not load auth configuration.");
            return response.json();
          }),
          fetch("/api/auth/me"),
        ]);
        if (!mounted) return;
        setConfig(authConfig);
        if (session.ok) setUser(await session.json());
        else if (!authConfig.enabled) setUser({ id: "local-development", email: "local@video.local" });
      } catch (error) {
        if (!mounted) return;
        setConfig({ enabled: false });
        setUser({ id: "local-development", email: "local@video.local" });
        setNotice(error instanceof Error ? error.message : "Could not initialize the workspace.");
      }
    })();
    fetch("/api/health/ready").then((response) => mounted && setHealth(response.ok)).catch(() => mounted && setHealth(false));
    return () => { mounted = false; };
  }, []);

  useEffect(() => { if (user) load(); }, [user, load]);
  const hasActiveVideos = videos.some((video) => activeStatuses.has(video.status));
  useEffect(() => {
    if (!user || !hasActiveVideos) return;
    const interval = setInterval(load, 2500);
    return () => clearInterval(interval);
  }, [user, load, hasActiveVideos]);

  const counts = useMemo(() => ({
    total: videos.length,
    completed: videos.filter((video) => video.status === "completed").length,
    active: videos.filter((video) => activeStatuses.has(video.status)).length,
  }), [videos]);
  const filteredVideos = useMemo(() => videos.filter((video) => {
    const matchesQuery = video.originalFilename.toLowerCase().includes(query.toLowerCase()) || video.id.includes(query);
    const matchesFilter = filter === "all" || filter === video.status || (filter === "active" && activeStatuses.has(video.status));
    return matchesQuery && matchesFilter;
  }), [videos, query, filter]);

  async function signOut() {
    await fetch("/api/auth/session", { method: "DELETE" });
    setUser(null);
  }
  function put(url: string, headers: Record<string, string>, file: File) {
    return new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("PUT", url);
      Object.entries(headers).forEach(([key, value]) => request.setRequestHeader(key, value));
      request.upload.onprogress = (event) => event.lengthComputable && setProgress(Math.round(event.loaded / event.total * 100));
      request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error("Object storage rejected the upload."));
      request.onerror = () => reject(new Error("Could not reach object storage."));
      request.send(file);
    });
  }
  async function upload(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".mp4") || !["video/mp4", "application/octet-stream"].includes(file.type || "application/octet-stream")) return setNotice("Choose an MP4 video file.");
    if (file.size <= 0) return setNotice("The selected file is empty.");
    if (file.size > maxUploadBytes) return setNotice("The selected video exceeds the 500 MB limit.");
    setUploading(true); setUploadName(file.name); setProgress(0); setNotice("");
    try {
      const created = await fetch("/api/videos/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: file.name, contentType: "video/mp4", sizeBytes: file.size }) });
      const data = await created.json();
      if (!created.ok) throw new Error(data.error?.message || "Could not create upload.");
      await put(data.upload.url, data.upload.headers, file);
      const completed = await fetch(`/api${data.completeUrl}`, { method: "POST" });
      if (!completed.ok) throw new Error((await completed.json()).error?.message || "Could not start processing.");
      await load();
      location.href = `/player/${data.videoId}`;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Upload failed.");
      setUploading(false);
    }
  }
  async function deleteVideo(video: Video) {
    if (!confirm(`Delete ${video.originalFilename}? This permanently removes its source and generated streams.`)) return;
    const response = await fetch(`/api/videos/${video.id}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return setNotice(body.error?.message || "Could not delete the video.");
    }
    setVideos((current) => current.filter((item) => item.id !== video.id));
    setNotice(`${video.originalFilename} was deleted.`);
  }

  if (!config) return <div className="grid min-h-screen place-items-center text-muted-foreground">Loading Frameflow…</div>;
  if (config.enabled && !user) return <AuthGate config={config} onAuthenticated={setUser} />;
  if (!user) return null;
  return <>
    <header className="mx-auto flex h-19 w-[min(1180px,calc(100%-2rem))] items-center justify-between border-b">
      <Brand /><div className="flex items-center gap-3"><Link href="/system"><Button variant="outline"><Activity />System</Button></Link><span className="hidden text-sm text-muted-foreground sm:inline">{user.email}</span><span className="grid size-8 place-items-center rounded-full bg-secondary text-sm font-bold">{(user.email || "L").charAt(0).toUpperCase()}</span>{config.enabled && <Button variant="ghost" onClick={signOut}>Sign out</Button>}</div>
    </header>
    <main className="mx-auto w-[min(1180px,calc(100%-2rem))] pb-20">
      <section className="grid items-end gap-10 py-14 lg:grid-cols-[1.3fr_.7fr]"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-brand">Local video infrastructure</p><h1 className="mt-4 text-6xl font-bold leading-[.9] tracking-[-.075em] md:text-8xl">From source to <em className="font-serif-accent font-normal text-brand">stream.</em></h1><p className="mt-7 max-w-2xl text-lg leading-8 text-muted-foreground">Upload an MP4 once. Frameflow orchestrates validation, parallel transcoding, and adaptive HLS delivery through a resilient Hatchet workflow.</p></div><div className="hidden border-l pl-6 text-muted-foreground lg:block"><strong className="mb-2 block text-sm text-foreground">Built for reliability</strong>Direct uploads, isolated worker scratch space, retry-safe publication, and private playback.</div></section>
      {notice && <div role="status" className="mb-5 flex items-center justify-between rounded-xl border bg-card px-4 py-3 text-sm"><span>{notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice("")}><X className="size-4" /></button></div>}
      <section className="grid gap-5 lg:grid-cols-[1fr_290px]">
        <Card className="overflow-hidden"><CardHeader className="flex-row items-start justify-between"><div><CardTitle className="text-2xl">Process a new video</CardTitle><CardDescription>MP4 · minimum 1280×720 · up to 500 MB</CardDescription></div><Badge status="completed">Ready</Badge></CardHeader><CardContent>{uploading ? <div className="rounded-xl bg-muted p-5"><div className="mb-3 flex justify-between text-sm"><strong>{uploadName}</strong><span>{progress}%</span></div><Progress value={progress} /><p className="mt-3 text-xs text-muted-foreground">Uploading directly to private object storage…</p></div> : <div role="button" tabIndex={0} onClick={() => fileInput.current?.click()} onKeyDown={(event) => event.key === "Enter" && fileInput.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); upload(event.dataTransfer.files[0]); }} className={`grid min-h-52 cursor-pointer place-items-center rounded-xl border border-dashed p-8 text-center transition ${dragging ? "border-brand bg-brand/5" : "bg-muted/30 hover:bg-muted/60"}`}><input ref={fileInput} type="file" accept="video/mp4,.mp4" className="hidden" onChange={(event) => upload(event.target.files?.[0])} /><span><span className="mx-auto mb-4 grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground"><ArrowUp /></span><strong className="block">Drop your video here</strong><span className="mt-1 block text-sm text-muted-foreground">or click to choose an MP4 file</span></span></div>}</CardContent></Card>
        <aside className="grid grid-cols-3 gap-3 lg:grid-cols-1">{[["Total videos", counts.total], ["Completed", counts.completed], ["In progress", counts.active]].map(([label, value]) => <Card key={String(label)}><CardContent className="p-5"><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-2 text-4xl font-bold tracking-tight">{value}</p></CardContent></Card>)}<Link href="/system" className="col-span-3 lg:col-span-1"><Card><CardContent className="flex items-center justify-between p-5 text-sm"><span>Local services</span><span className={health ? "text-emerald-700" : "text-destructive"}>{health ? "All systems ready" : "Unavailable"}</span></CardContent></Card></Link></aside>
        <section className="lg:col-span-2">
          <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><h2 className="text-2xl font-semibold tracking-tight">Your workspace</h2><p className="text-sm text-muted-foreground">Recent uploads and processing activity</p></div><div className="flex flex-wrap items-center gap-2"><div className="relative"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label="Search videos" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search videos" className="w-52 pl-9" /></div>{(["all", "active", "completed", "failed"] as Filter[]).map((value) => <Button key={value} size="sm" variant={filter === value ? "default" : "outline"} onClick={() => setFilter(value)} className="capitalize">{value}</Button>)}<Button size="sm" variant="ghost" onClick={load}><RefreshCw />Refresh</Button></div></div>
          <div className="space-y-2">{loading ? <Card className="h-20 animate-pulse bg-muted" /> : filteredVideos.length ? filteredVideos.map((video) => <div key={video.id} className="group grid grid-cols-[52px_1fr_auto_auto_auto] items-center gap-3 rounded-xl border bg-card p-3 shadow-xs transition hover:bg-accent"><Link href={`/player/${video.id}`} className="grid h-11 place-items-center rounded-lg bg-primary text-primary-foreground"><Play className="size-4 fill-current" /></Link><Link href={`/player/${video.id}`} className="min-w-0"><strong className="block truncate text-sm">{video.originalFilename}</strong><span className="text-xs text-muted-foreground">{formatSize(video.sizeBytes)} · {video.id.slice(0, 8)}</span></Link><Badge status={video.status}>{video.status}</Badge>{["completed", "failed"].includes(video.status) && <Button aria-label={`Delete ${video.originalFilename}`} size="icon" variant="ghost" className="text-muted-foreground opacity-50 hover:text-destructive group-hover:opacity-100" onClick={() => deleteVideo(video)}><Trash2 /></Button>}<Link href={`/player/${video.id}`} aria-label={`Open ${video.originalFilename}`}><ChevronRight className="size-4 text-muted-foreground" /></Link></div>) : <Card><CardContent className="grid place-items-center py-14 text-center"><Upload className="mb-3 text-muted-foreground" /><strong>{videos.length ? "No matching videos" : "No videos yet"}</strong><p className="text-sm text-muted-foreground">{videos.length ? "Try a different search or status filter." : "Upload an MP4 to run your first workflow."}</p></CardContent></Card>}</div>
        </section>
      </section>
    </main>
  </>;
}
