import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// The server runs from apps/server (npm workspace scripts), so the repository root is two folders up. It reads the
// one root .env.local when it exists (D54); CI and the pod set the variables directly.
const root = resolve(process.cwd(), "../..");
const envFile = resolve(root, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config: NextConfig = {
  compress: false, // compression must never hold back the NDJSON stream (spec 8.1)
  transpilePackages: [
    "@dokaanbondhu/contracts",
    "@dokaanbondhu/core",
    "@dokaanbondhu/engine",
    "@dokaanbondhu/i18n",
    "@dokaanbondhu/platform-db",
  ],
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default config;
