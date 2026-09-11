import type { NextConfig } from "next";

// Build-time: `next build` bakes these rewrite destinations into .next/routes-manifest.json, so set API_ORIGIN before building.
const apiOrigin = process.env.API_ORIGIN ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  // NEXT_OUTPUT=standalone at build time emits .next/standalone with a minimal server.js for container images.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${apiOrigin}/auth/:path*` },
      { source: "/api/videos/:path*", destination: `${apiOrigin}/videos/:path*` },
      { source: "/api/health/:path*", destination: `${apiOrigin}/health/:path*` },
      { source: "/api/social/:path*", destination: `${apiOrigin}/social/:path*` },
      { source: "/streams/:path*", destination: `${apiOrigin}/streams/:path*` },
    ];
  },
};

export default nextConfig;
