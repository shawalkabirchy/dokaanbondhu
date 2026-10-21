import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scannerSummarySchema, type ScannerSummary } from "@dokaanbondhu/contracts";
import { detect } from "./detect";
import { SourceReader } from "./files";
import { parseRouteList, runRouteList } from "./routes";
import { scan } from "./scan";
import { summaryText } from "./summary";
import { upload } from "./upload";

// One scan, from the folder to the upload (spec 16.2, 16.3). The console, the question and the network are passed
// in, so the tests run it whole.

export interface RunOptions {
  dir: string;
  out?: string;
  server?: string;
  token?: string;
  /** A saved route:list --json output, instead of running PHP. */
  routes?: string;
  php?: string;
}

export interface RunIo {
  print(text: string): void;
  ask(question: string): Promise<string>;
  readFile(path: string): Promise<string>;
  fetch?: typeof fetch;
}

/** The exit code: 0 done, 1 failed, 2 not needed (the app publishes OpenAPI, or is no Laravel app). */
export async function run(
  options: RunOptions,
  io: RunIo,
): Promise<{ code: number; summary?: ScannerSummary }> {
  if (Boolean(options.server) !== Boolean(options.token)) {
    io.print("Give both --server and --token to upload, or neither.");
    return { code: 1 };
  }
  const dir = resolve(options.dir);
  const reader = new SourceReader(dir);
  const detection = detect(reader);
  if (detection.kind !== "laravel") {
    io.print(detection.message);
    return { code: 2 };
  }
  const output = options.routes ? await io.readFile(options.routes) : await runRouteList(dir, options.php);
  const summary = scannerSummarySchema.parse(scan(reader, parseRouteList(output), detection.psr4));
  io.print(summaryText(summary));
  if (options.out) {
    await writeFile(options.out, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    io.print(`\nSummary written to ${options.out}`);
  }
  if (!options.server || !options.token) return { code: 0, summary };

  // The question is always asked (spec 16.3): no option skips it.
  const answer = (await io.ask("\nUpload this summary? [y/N] ")).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    io.print("Not uploaded.");
    return { code: 0, summary };
  }
  const result = await upload(options.server, options.token, summary, io.fetch);
  const count = (list?: string[]) => list?.length ?? 0;
  io.print(
    `Uploaded: ${count(result.added)} new, ${count(result.changed)} changed, ${count(result.kept)} the same, ` +
      `${count(result.removed)} gone. Open DokaanBondhu's setup to check each action and choose which to switch on.`,
  );
  return { code: 0, summary };
}
