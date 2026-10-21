import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

// The only way the scanner reads the app's files (spec 16.3): never .env, vendor/, node_modules/, storage/ or .git/,
// and nothing outside the project folder. Every file read is counted for the summary.

const NEVER = [/^\.env(\.|$)/, /^vendor(\/|$)/, /^node_modules(\/|$)/, /^storage(\/|$)/, /^\.git(\/|$)/];

/** What the scanner never opens, as the summary says it. */
export const SKIPPED = [".env", "vendor/", "node_modules/", "storage/", ".git/"];

export class SourceReader {
  readonly read = new Set<string>();

  constructor(readonly root: string) {}

  /** The project-relative path with forward slashes, or null when it leaves the project. */
  private inside(path: string): string | null {
    const rel = relative(resolve(this.root), resolve(this.root, path)).split(sep).join("/");
    return rel.startsWith("..") || rel === "" ? null : rel;
  }

  /** Whether the scanner may open this file at all. */
  allowed(path: string): boolean {
    const rel = this.inside(path);
    return rel !== null && !NEVER.some((pattern) => pattern.test(rel));
  }

  exists(path: string): boolean {
    return this.allowed(path) && existsSync(resolve(this.root, path));
  }

  /** A file's text, or null when it is missing; throws for a file the scanner must never open. */
  text(path: string): string | null {
    if (!this.allowed(path)) throw new Error(`the scanner never opens ${path}`);
    const full = resolve(this.root, path);
    if (!existsSync(full)) return null;
    this.read.add(this.inside(path)!);
    return readFileSync(full, "utf8");
  }
}
