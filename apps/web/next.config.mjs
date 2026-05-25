import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  outputFileTracingRoot: path.join(process.cwd(), "../..")
};

export default nextConfig;
