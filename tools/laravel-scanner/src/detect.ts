import type { SourceReader } from "./files";

// Is this a Laravel app, and does it already publish an OpenAPI document (spec 16.2, step 1)?

export type Detection =
  | { kind: "laravel"; psr4: [string, string][] }
  | { kind: "openapi"; package: string; message: string }
  | { kind: "not-laravel"; message: string };

const OPENAPI_PACKAGES: Record<string, string> = {
  "darkaonline/l5-swagger": "L5-Swagger usually serves it at /docs/api-docs.json (or /api/documentation)",
  "knuckleswtf/scribe": "Scribe usually serves it at /docs.openapi",
};

type Composer = {
  require?: Record<string, string>;
  "require-dev"?: Record<string, string>;
  autoload?: { "psr-4"?: Record<string, string | string[]> };
};

export function detect(reader: SourceReader): Detection {
  const raw = reader.text("composer.json");
  if (!reader.exists("artisan") || raw === null)
    return { kind: "not-laravel", message: "No Laravel app here: artisan and composer.json were not found." };
  let composer: Composer;
  try {
    composer = JSON.parse(raw) as Composer;
  } catch {
    return { kind: "not-laravel", message: "composer.json could not be read as JSON." };
  }
  const packages = { ...composer.require, ...composer["require-dev"] };
  if (!packages["laravel/framework"])
    return { kind: "not-laravel", message: "composer.json does not require laravel/framework." };
  for (const [name, where] of Object.entries(OPENAPI_PACKAGES)) {
    if (packages[name])
      return {
        kind: "openapi",
        package: name,
        message:
          `This app already publishes an OpenAPI document (${name}). ${where}. ` +
          "Import that document in DokaanBondhu's setup instead; the scanner is not needed.",
      };
  }
  const psr4: [string, string][] = [];
  for (const [prefix, dirs] of Object.entries(composer.autoload?.["psr-4"] ?? { "App\\": "app/" }))
    for (const dir of Array.isArray(dirs) ? dirs : [dirs]) psr4.push([prefix, dir.replace(/\/?$/, "/")]);
  // The longest namespace first, so App\Domain\ wins over App\.
  psr4.sort((a, b) => b[0].length - a[0].length);
  return { kind: "laravel", psr4 };
}
