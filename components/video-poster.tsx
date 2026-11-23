"use client";

import { useRef, useState, type ReactNode } from "react";

/**
 * The picture on a video card: the thumbnail, with the short muted preview playing over it while the card is hovered
 * or focused. The preview is only requested on the first hover. A video without a thumbnail keeps the fallback.
 */
export function VideoPoster({ thumbnailUrl, previewUrl, title, fallbackClassName, children }: {
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
  title: string;
  fallbackClassName: string;
  children?: ReactNode;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [wanted, setWanted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [broken, setBroken] = useState(false);
  const showThumbnail = Boolean(thumbnailUrl) && !broken;

  const start = () => {
    if (!previewUrl) return;
    setWanted(true);
    // On the first hover the element does not exist yet; autoPlay starts it. Later hovers replay from the beginning.
    const element = video.current;
    if (element) { element.currentTime = 0; void element.play().catch(() => undefined); }
  };
  const stop = () => { video.current?.pause(); setPlaying(false); };

  return (
    <div
      className={`relative aspect-video overflow-hidden rounded-xl ${showThumbnail ? "bg-black" : fallbackClassName}`}
      onMouseEnter={start} onMouseLeave={stop} onFocus={start} onBlur={stop}
    >
      {showThumbnail && (
        // eslint-disable-next-line @next/next/no-img-element -- served by the stream route with its own caching and access rules
        <img src={thumbnailUrl!} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className="absolute inset-0 size-full object-cover" />
      )}
      {wanted && previewUrl && (
        <video
          ref={video} src={previewUrl} muted loop playsInline autoPlay preload="auto" aria-label={`Preview of ${title}`}
          onPlaying={() => setPlaying(true)} onError={() => setPlaying(false)}
          className={`absolute inset-0 size-full object-cover transition-opacity duration-200 ${playing ? "opacity-100" : "opacity-0"}`}
        />
      )}
      {children}
    </div>
  );
}
