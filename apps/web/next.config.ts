import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const storageOrigin = (() => {
  try {
    return new URL(process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000")
      .origin;
  } catch {
    return "http://localhost:9000";
  }
})();

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${
    process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""
  }`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  `connect-src 'self' ${storageOrigin}${
    process.env.NODE_ENV === "development" ? " ws: wss:" : ""
  }`,
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  images: { unoptimized: true },
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  outputFileTracingExcludes: {
    "*": ["node_modules/.pnpm/@img+*/**", "node_modules/.pnpm/sharp@*/**"],
  },
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    "@understandproof/analysis",
    "@understandproof/auth",
    "@understandproof/config",
    "@understandproof/db",
    "@understandproof/domain",
    "@understandproof/github",
    "@understandproof/media",
    "@understandproof/observability",
    "@understandproof/policy",
    "@understandproof/providers",
    "@understandproof/questions",
    "@understandproof/storage",
  ],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), geolocation=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
