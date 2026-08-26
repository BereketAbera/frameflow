"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bookmark,
  Heart,
  MessageCircle,
  RotateCcw,
  Send,
  Share2,
} from "lucide-react";
import { AdaptiveVideoPlayer } from "@/components/adaptive-video-player";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Detail = {
  video: {
    id: string;
    title: string;
    description: string;
    tags: string;
    creator: string;
    userId: string;
    viewCount: number;
    likes: number;
    liked: boolean;
    saved: boolean;
  };
  comments: {
    id: string;
    body: string;
    author: string;
    createdAt: string;
    userId: string;
  }[];
};

export function WatchView({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [playbackError, setPlaybackError] = useState("");
  const [busy, setBusy] = useState("");
  const [ownerMode, setOwnerMode] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/social/videos/${id}`);
      if (response.status === 404) {
        throw new Error("This video is private, unavailable, or no longer exists.");
      }
      if (!response.ok) throw new Error("Could not load this video.");
      setData(await response.json());
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load this video.",
      );
    }
  }, [id]);

  useEffect(() => {
    fetch("/api/auth/config")
      .then((response) => (response.ok ? response.json() : null))
      .then((config) => setOwnerMode(config?.mode === "owner"))
      .catch(() => setOwnerMode(false));
  }, []);

  useEffect(() => {
    load();
    const key = `frameflow-viewed-${id}`;
    if (!sessionStorage.getItem(key)) {
      fetch(`/api/social/videos/${id}/view`, { method: "POST" }).then(
        (response) => {
          if (response.ok) sessionStorage.setItem(key, "1");
        },
      );
    }
  }, [id, load]);

  async function action(kind: "like" | "save") {
    setBusy(kind);
    const response = await fetch(`/api/social/videos/${id}/${kind}`, {
      method: "POST",
    });
    setBusy("");
    if (response.status === 401) {
      return setError(
        ownerMode
          ? "This public demo is read-only. Likes and saves are limited to the owner."
          : "Sign in to like and save videos.",
      );
    }
    if (!response.ok) return setError(`Could not ${kind} this video.`);
    load();
  }

  async function comment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("comment");
    const form = event.currentTarget;
    const body = String(new FormData(form).get("body"));
    const response = await fetch(`/api/social/videos/${id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    setBusy("");
    if (response.status === 401) {
      return setError(
        ownerMode
          ? "This public demo is read-only. Comments are limited to the owner."
          : "Sign in to join the conversation.",
      );
    }
    if (!response.ok) return setError("Could not post your comment.");
    form.reset();
    load();
  }

  if (error && !data) {
    return (
      <>
        <SiteHeader />
        <main className="grid min-h-[70vh] place-items-center p-6 text-center">
          <div>
            <AlertTriangle className="mx-auto mb-4 size-10 text-brand" />
            <h1 className="text-3xl font-bold">Video unavailable</h1>
            <p className="mt-2 text-muted-foreground">{error}</p>
            <Button asChild className="mt-5">
              <Link href="/discover">Back to discovery</Link>
            </Button>
          </div>
        </main>
      </>
    );
  }

  if (!data) {
    return <div className="grid min-h-screen place-items-center">Loading film…</div>;
  }

  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-[min(1180px,calc(100%-2rem))] py-8">
        {error && (
          <p
            role="alert"
            className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <div className="relative aspect-video overflow-hidden rounded-2xl bg-black shadow-2xl">
          <AdaptiveVideoPlayer
            src={`/streams/${id}/master.m3u8`}
            title={data.video.title}
            onPlaybackError={setPlaybackError}
          />
          {playbackError && (
            <div className="absolute inset-0 z-20 grid place-items-center bg-black/85 p-6 text-center text-white">
              <div>
                <AlertTriangle className="mx-auto mb-3 text-brand" />
                <p>{playbackError}</p>
                <Button
                  className="mt-4"
                  variant="outline"
                  onClick={() => location.reload()}
                >
                  <RotateCcw />
                  Retry
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className="mt-7 grid gap-10 lg:grid-cols-[1fr_360px]">
          <section>
            <h1 className="text-4xl font-bold tracking-tight">
              {data.video.title}
            </h1>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <Link
                href={`/profile/${data.video.userId}`}
                className="font-semibold"
              >
                {data.video.creator || "Frameflow creator"}
              </Link>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!!busy}
                  variant={data.video.liked ? "brand" : "outline"}
                  onClick={() => action("like")}
                >
                  <Heart className={data.video.liked ? "fill-current" : ""} />
                  {data.video.likes}
                </Button>
                <Button
                  disabled={!!busy}
                  variant={data.video.saved ? "default" : "outline"}
                  onClick={() => action("save")}
                >
                  <Bookmark />
                  Save
                </Button>
                <Button
                  variant="outline"
                  onClick={() => navigator.clipboard.writeText(location.href)}
                >
                  <Share2 />
                  Share
                </Button>
              </div>
            </div>
            <p className="mt-6 leading-7 text-muted-foreground">
              {data.video.description ||
                "An AI video created and published through Frameflow."}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {data.video.tags
                .split(",")
                .filter(Boolean)
                .map((tag) => (
                  <span
                    className="rounded-full bg-muted px-3 py-1 text-xs"
                    key={tag}
                  >
                    #{tag.trim()}
                  </span>
                ))}
            </div>
            <p className="mt-6 text-sm text-muted-foreground">
              {data.video.viewCount} views
            </p>
          </section>
          <aside>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <MessageCircle />
              Comments ({data.comments.length})
            </h2>
            <form onSubmit={comment} className="mt-4 flex gap-2">
              <Input
                name="body"
                placeholder="Join the conversation"
                required
                maxLength={1000}
              />
              <Button
                disabled={!!busy}
                size="icon"
                aria-label="Post comment"
              >
                <Send />
              </Button>
            </form>
            <div className="mt-5 space-y-5">
              {data.comments.map((entry) => (
                <div key={entry.id}>
                  <strong className="text-sm">{entry.author}</strong>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {entry.body}
                  </p>
                </div>
              ))}
              {!data.comments.length && (
                <p className="text-sm text-muted-foreground">
                  Be the first to comment.
                </p>
              )}
            </div>
          </aside>
        </div>
      </main>
    </>
  );
}
