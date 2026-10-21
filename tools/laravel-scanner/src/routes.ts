import { execFile } from "node:child_process";

// The app's routes, from `php artisan route:list --json` (spec 16.2): run with the host's own PHP, 60 s at most.

export interface RouteEntry {
  /** "GET|HEAD", "POST", "PUT|PATCH". */
  method: string;
  /** Without the leading slash: "api/sales/{sale}". */
  uri: string;
  name: string | null;
  /** "App\Http\Controllers\SaleController@store", an invokable class, or "Closure". */
  action: string;
  /** Route middleware: short names (web, auth:sanctum) or, as Laravel 10 and later list them, resolved classes. */
  middleware: string[];
  /** Laravel marks a package's routes. */
  vendor: boolean;
}

const ROUTE_LIST_MS = 60_000;

/** Runs route:list in the project folder and gives its output. */
export function runRouteList(dir: string, php = "php"): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      php,
      ["artisan", "route:list", "--json"],
      { cwd: dir, timeout: ROUTE_LIST_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const reason = error.killed
            ? "it took longer than 60 seconds"
            : String(stderr || error.message).trim();
          fail(new Error(`php artisan route:list --json did not work: ${reason.slice(0, 500)}`));
          return;
        }
        done(stdout);
      },
    );
  });
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * route:list's JSON to routes. PHP notices printed before the list are passed over; Laravel's "no routes" message
 * (it is not JSON) is no routes.
 */
export function parseRouteList(output: string): RouteEntry[] {
  const start = output.indexOf("[");
  if (start < 0) return [];
  const list: unknown = JSON.parse(output.slice(start));
  if (!Array.isArray(list)) throw new Error("route:list did not give a list of routes");
  return list.map((raw: Record<string, unknown>) => {
    const middleware = Array.isArray(raw.middleware)
      ? raw.middleware.map(String)
      : text(raw.middleware)
          .split(/[\n,]/)
          .map((name) => name.trim())
          .filter(Boolean);
    return {
      method: text(raw.method),
      uri: text(raw.uri),
      name: typeof raw.name === "string" && raw.name ? raw.name : null,
      action: text(raw.action),
      middleware,
      vendor: raw.vendor === true,
    };
  });
}
