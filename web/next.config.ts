import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The desktop app (../desktop) runs .next/standalone/server.js.
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    serverActions: {
      // Message attachments: up to 5 images x 5MB, plus multipart overhead.
      bodySizeLimit: "30mb",
    },
    // Keep the route cache in memory. The desktop app runs the server from inside its signed app bundle;
    // writing .next/server/route-cache there breaks the macOS code signature ("damaged" on the next launch)
    // and fails where the install folder is read-only.
    isrFlushToDisk: false,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
