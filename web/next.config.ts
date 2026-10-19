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
