"use client";

import { HlsJsVideo } from "@videojs/react/media/hlsjs-video";
import { NeutralVideoSkin, VideoPlayer } from "@videojs/react/video";

type AdaptiveVideoPlayerProps = {
  src: string;
  title: string;
  onPlaybackError: (message: string) => void;
};

export function AdaptiveVideoPlayer({
  src,
  title,
  onPlaybackError,
}: AdaptiveVideoPlayerProps) {
  return (
    <VideoPlayer title={title}>
      <NeutralVideoSkin className="frameflow-video-skin">
        <HlsJsVideo
          aria-label={title}
          data-testid="frameflow-video"
          onCanPlay={() => onPlaybackError("")}
          onError={() =>
            onPlaybackError(
              "Playback stopped because the adaptive stream could not be loaded.",
            )
          }
          onLoadStart={() => onPlaybackError("")}
          playsInline
          preload="metadata"
          source={{
            src,
            type: "application/vnd.apple.mpegurl",
            preferPlayback: "mse",
            engine: { hlsJs: { enableWorker: true } },
          }}
        />
      </NeutralVideoSkin>
    </VideoPlayer>
  );
}
