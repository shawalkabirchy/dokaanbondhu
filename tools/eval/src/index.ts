import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadItems, type Item } from "./items";
import { runItems, type RunState } from "./run";
import { buildReport, renderMarkdown, scoreItem } from "./score";
import { Session, type EvalEnv } from "./session";

// npm run eval -- run [--split open|held_out|all] [--channel chat|voice|all] [--kind <kinds>] [--ids <ids>]
//                     [--limit <n>] [--built-actions <actions>]
// npm run eval -- run --resume [--run <id>]
// npm run eval -- score [--run <id>]
// The held-out split is for the final run only (build step 9); the default is the open split.

/** Scripts print through stdout; console is kept for warnings and errors (lint rule). */
const print = (line: string) => process.stdout.write(`${line}\n`);

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const runsDir = join(root, "runs");

const envSchema = z.object({
  EVAL_SERVER_URL: z.url(),
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(20),
  EVAL_MODE_SECRET: z.string().min(16),
  EVAL_OWNER_EMAIL: z.string().min(3),
  EVAL_OWNER_PASSWORD: z.string().min(1),
  EVAL_STAFF_EMAIL: z.string().min(3),
  EVAL_STAFF_PASSWORD: z.string().min(1),
});

function latestRun(): string {
  const runs = existsSync(runsDir) ? readdirSync(runsDir).sort() : [];
  const last = runs.at(-1);
  if (!last) throw new Error("no earlier run in tools/eval/runs");
  return last;
}

function writeReport(items: Item[], state: RunState): string {
  const byId = new Map(items.map((item) => [item.id, item]));
  const scores = state.results.flatMap((result) => {
    const item = byId.get(result.id);
    return item ? [scoreItem(item, result)] : [];
  });
  const report = buildReport(state.runId, scores);
  const dir = join(runsDir, state.runId);
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, "report.md"), renderMarkdown(report));
  return join(dir, "report.md");
}

async function main() {
  const [command = "run", ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      split: { type: "string", default: "open" },
      channel: { type: "string", default: "all" },
      kind: { type: "string" },
      ids: { type: "string" },
      limit: { type: "string" },
      "built-actions": { type: "string", default: "" },
      resume: { type: "boolean", default: false },
      run: { type: "string" },
    },
  });
  const all = loadItems(join(root, "items.jsonl"));

  if (command === "score") {
    const runId = values.run ?? latestRun();
    const state = JSON.parse(readFileSync(join(runsDir, runId, "run-state.json"), "utf8")) as RunState;
    print(`report: ${writeReport(all, state)}`);
    return;
  }
  if (command !== "run") throw new Error(`unknown command ${command}; use run or score`);

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `missing settings in .env.local: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  }
  const env = parsed.data;
  const evalEnv: EvalEnv = {
    serverUrl: env.EVAL_SERVER_URL.replace(/\/$/, ""),
    supabaseUrl: env.SUPABASE_URL,
    supabaseKey: env.SUPABASE_SECRET_KEY,
    evalKey: env.EVAL_MODE_SECRET,
  };
  const sessions = {
    owner: new Session(evalEnv, { email: env.EVAL_OWNER_EMAIL, password: env.EVAL_OWNER_PASSWORD }, "owner"),
    staff: new Session(evalEnv, { email: env.EVAL_STAFF_EMAIL, password: env.EVAL_STAFF_PASSWORD }, "staff"),
  };

  let state: RunState;
  if (values.resume) {
    const runId = values.run ?? latestRun();
    state = JSON.parse(readFileSync(join(runsDir, runId, "run-state.json"), "utf8")) as RunState;
    print(`resuming ${runId} at item ${state.nextIndex + 1} of ${state.itemIds.length}`);
  } else {
    const kinds = values.kind?.split(",");
    const ids = values.ids?.split(",");
    let chosen = all.filter(
      (item) =>
        (values.split === "all" || item.split === values.split) &&
        (values.channel === "all" || item.channel === values.channel) &&
        (!kinds || kinds.includes(item.kind)) &&
        (!ids || ids.includes(item.id)),
    );
    if (values.limit) chosen = chosen.slice(0, Number(values.limit));
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    state = {
      runId,
      startedAt: new Date().toISOString(),
      itemIds: chosen.map((item) => item.id),
      builtActions: values["built-actions"] ? values["built-actions"].split(",") : [],
      nextIndex: 0,
      results: [],
    };
    mkdirSync(join(runsDir, runId), { recursive: true });
    print(`run ${runId}: ${chosen.length} items against ${evalEnv.serverUrl}`);
    print(
      "The host must be fresh: npm run db:reset-demo in GearGrid, then npm run admin -- sync-catalog --shop <id> (spec 18.4).",
    );
  }
  const byId = new Map(all.map((item) => [item.id, item]));
  const items = state.itemIds.map((id) => byId.get(id)!).filter(Boolean);
  const save = (next: RunState) =>
    writeFileSync(join(runsDir, next.runId, "run-state.json"), JSON.stringify(next, null, 2));
  const finished = await runItems(items, state, sessions, save, print);
  if (finished.stopped) {
    print(`stopped: ${finished.stopped.reason}. Continue after 00:00 UTC with: npm run eval -- run --resume`);
  }
  print(`report: ${writeReport(all, finished)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
