import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Command } from "commander";
import { run, type RunOptions } from "./run";
import { SCANNER_VERSION } from "./scan";

// node dokaanbondhu-laravel-scan.mjs [--dir <path>] [--out summary.json] [--server <url> --token <setup token>]
// (spec 16.1). Read-only: it lists the app's routes and rules, shows the summary, and uploads it only after a yes.

/** One line from the keyboard (or a pipe); the end of the input is no answer. */
function ask(question: string): Promise<string> {
  return new Promise((done) => {
    const lines = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
    });
    let answered = false;
    lines.once("line", (line) => {
      answered = true;
      lines.close();
      done(line);
    });
    lines.once("close", () => {
      if (!answered) done("");
    });
    process.stdout.write(question);
  });
}

const program = new Command()
  .name("dokaanbondhu-laravel-scan")
  .description(
    "Reads a Laravel app's routes and validation rules for DokaanBondhu. It changes nothing, never opens .env, " +
      "vendor/, node_modules/, storage/ or .git/, and uploads only the summary, after you say yes.",
  )
  .version(SCANNER_VERSION)
  .option("--dir <path>", "the Laravel project folder", process.cwd())
  .option("--out <file>", "also save the summary to this JSON file")
  .option("--server <url>", "DokaanBondhu's server address, to upload the summary")
  .option("--token <token>", "the one-time setup token from DokaanBondhu")
  .option("--routes <file>", "a saved `php artisan route:list --json` output, instead of running PHP here")
  .option("--php <command>", "the PHP command", "php")
  .action(async (options: RunOptions) => {
    try {
      const { code } = await run(options, {
        print: (text) => process.stdout.write(`${text}\n`),
        ask,
        readFile: (path) => readFile(path, "utf8"),
      });
      process.exitCode = code;
    } catch (error) {
      process.stderr.write(`The scan stopped: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  });

await program.parseAsync();
