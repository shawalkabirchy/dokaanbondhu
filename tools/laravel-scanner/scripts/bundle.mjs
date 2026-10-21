import { build } from "esbuild";

// One readable file for the owner to run (spec 16.1): dist/dokaanbondhu-laravel-scan.mjs, Node 22.12 or newer.
// Not minified, so anyone can read what it does before running it.

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/dokaanbondhu-laravel-scan.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.12",
  minify: false,
  legalComments: "inline",
  banner: {
    js: [
      "#!/usr/bin/env node",
      "// DokaanBondhu Laravel scanner: reads a Laravel app's routes and validation rules, read-only.",
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});
