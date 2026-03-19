import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
const repoName = "wire_finder_map";

const nextConfig: NextConfig = {
  output: "export",
  basePath: isProd ? `/${repoName}` : "",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
