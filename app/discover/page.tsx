"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Heart, Play, Search } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

type Video = {
  id: string;
  title: string;
  description: string;
  creator: string;
  tags: string;
  viewCount: number;
  likes: number;
  createdAt: string;
};

type Featured = {
  id: string;
  title: string;
  description: string;
  creator: string;
  thumbnailUrl: string;
  tool?: string;
  sourceUrl: string;
  tags: string;
};

function qualityLabel(tags: string): string | null {
  const normalized = tags.toLowerCase();
  const signals: Array<[string, string]> = [
    ["global grand prize", "Global Grand Prize"],
    ["grand prix", "Grand Prix"],
    ["gold winner", "Gold winner"],
    ["silver winner", "Silver winner"],
    ["honoree", "Festival honoree"],
    ["landmark", "Landmark film"],
  ];
  return signals.find(([tag]) => normalized.includes(tag))?.[1] ?? null;
}

export default function Discover() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [featured, setFeatured] = useState<Featured[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetch("/api/social/feed")
      .then((response) => response.json())
      .then((data) => {
        setVideos(data.videos);
        setFeatured(data.featured);
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
              Finished AI films selected for craft, story, and visual direction.
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

        {featured.length > 0 && (
          <section className="mt-14">
            <div className="mb-5">
              <h2 className="text-2xl font-semibold">10 exceptional AI films</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Direct from the filmmakers—no generated placeholders or model test clips.
              </p>
            </div>
            <div className="grid gap-x-4 gap-y-8 md:grid-cols-2 lg:grid-cols-4">
              {featured.map((video) => {
                const signal = qualityLabel(video.tags);
                return (
                  <a
                    href={video.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    key={video.id}
                    className="group"
                    title={`Watch ${video.title} on its original source`}
                  >
                    <div className="relative aspect-video overflow-hidden rounded-xl bg-muted">
                      <img
                        src={video.thumbnailUrl}
                        alt={`${video.title} film thumbnail`}
                        className="size-full object-cover transition duration-300 group-hover:scale-105"
                      />
                      {signal && (
                        <Badge className="absolute left-3 top-3 z-10 border-white/20 bg-black/70 text-white backdrop-blur">
                          {signal}
                        </Badge>
                      )}
                      <span className="absolute inset-0 grid place-items-center bg-black/20 opacity-0 transition group-hover:opacity-100">
                        <span className="grid size-11 place-items-center rounded-full bg-white text-black">
                          <Play className="size-4 fill-current" />
                        </span>
                      </span>
                    </div>
                    <div className="mt-3 min-w-0">
                      <strong className="line-clamp-1 text-sm">{video.title}</strong>
                      <p className="truncate text-xs text-muted-foreground">
                        {video.creator} · Original film ↗
                      </p>
                      {video.tool && (
                        <Badge className="mt-2 max-w-full whitespace-normal leading-4">
                          {video.tool}
                        </Badge>
                      )}
                    </div>
                  </a>
                );
              })}
            </div>
          </section>
        )}

        <section className="mt-14">
          <div className="mb-5 flex items-end justify-between">
            <h2 className="text-2xl font-semibold">From the community</h2>
            <span className="text-sm text-muted-foreground">{shown.length} videos</span>
          </div>
          <div className="grid gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((video, index) => (
              <Link href={`/watch/${video.id}`} key={video.id} className="group">
                <div
                  className={`relative aspect-video overflow-hidden rounded-xl bg-gradient-to-br ${
                    index % 2
                      ? "from-violet-950 via-fuchsia-700 to-orange-400"
                      : "from-slate-950 via-cyan-800 to-emerald-300"
                  }`}
                >
                  <span className="absolute inset-0 grid place-items-center">
                    <span className="grid size-12 place-items-center rounded-full bg-white/90 text-black opacity-0 shadow-lg transition group-hover:opacity-100">
                      <Play className="size-4 fill-current" />
                    </span>
                  </span>
                </div>
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
