import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The face-matching weights never change for a given face-api version.
  async headers() {
    return [
      { source: "/face-models/:file*", headers: [{ key: "cache-control", value: "public, max-age=31536000, immutable" }] },
      // Always fetch the newest service worker.
      { source: "/sw.js", headers: [{ key: "cache-control", value: "no-cache" }] },
    ];
  },
};

export default nextConfig;
