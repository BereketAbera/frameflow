"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Heart, Play, Search } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { Input } from "@/components/ui/input";
import { VideoPoster } from "@/components/video-poster";

type Video = {
  id: string;
  title: string;
  description: string;
  creator: string;
  tags: string;
  viewCount: number;
  likes: number;
  createdAt: string;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
};

export default function Discover() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetch("/api/social/feed")
      .then((response) => response.json())
      .then((data) => {
        setVideos(data.videos);
      });
  }, []);

  const shown = useMemo(
    () =>
      videos.filter((video) =>
        `${video.title} ${video.tags} ${video.creator}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [videos, query],
  );

  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-[min(1180px,calc(100%-2rem))] py-14">
        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.16em] text-brand">
              AI video community
            </p>
            <h1 className="mt-3 text-5xl font-bold tracking-tight">
              Discover what’s possible.
            </h1>
            <p className="mt-3 text-muted-foreground">
              Videos published on Frameflow.
            </p>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search creators, tools, styles"
              className="w-full pl-9 md:w-72"
            />
          </div>
        </div>

        <section className="mt-14">
          <div className="mb-5 flex items-end justify-between">
            <h2 className="text-2xl font-semibold">From the community</h2>
            <span className="text-sm text-muted-foreground">{shown.length} videos</span>
          </div>
          <div className="grid gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((video, index) => (
              <Link href={`/watch/${video.id}`} key={video.id} className="group">
                <VideoPoster
                  thumbnailUrl={video.thumbnailUrl}
                  previewUrl={video.previewUrl}
                  title={video.title}
                  fallbackClassName={`bg-gradient-to-br ${
                    index % 2
                      ? "from-violet-950 via-fuchsia-700 to-orange-400"
                      : "from-slate-950 via-cyan-800 to-emerald-300"
                  }`}
                >
                  {!video.previewUrl && <span className="pointer-events-none absolute inset-0 grid place-items-center">
                    <span className="grid size-12 place-items-center rounded-full bg-white/90 text-black opacity-0 shadow-lg transition group-hover:opacity-100">
                      <Play className="size-4 fill-current" />
                    </span>
                  </span>}
                </VideoPoster>
                <h3 className="mt-3 line-clamp-1 font-semibold">{video.title}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {video.creator || "Frameflow creator"} · {video.viewCount} views
                </p>
                <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                  <Heart className="size-3" />
                  {video.likes}
                </p>
              </Link>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
