import type { NextConfig } from "next";

const apiOrigin = process.env.API_ORIGIN ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
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
