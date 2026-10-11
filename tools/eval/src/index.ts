import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { toPcm16k } from "./audio";
import {
  keptConversations,
  loadClipLabels,
  scoreClip,
  summarize,
  type ClipResult,
  type ClipStorage,
} from "./clips";
import { loadItems, type Item } from "./items";
import { runItems, type LoadClip, type RunState } from "./run";
import { buildReport, renderMarkdown, scoreItem } from "./score";
import { Session, type EvalEnv } from "./session";

// npm run eval -- run [--split open|held_out|all] [--channel chat|voice|all] [--style bangla|banglish|all]
//                     [--kind <kinds>] [--ids <ids>] [--limit <n>] [--built-actions <actions>]
// npm run eval -- run --resume [--run <id>]
// npm run eval -- score [--run <id>]
// npm run eval -- say --file <audio file> [--as owner|staff]   one spoken question from a file, printed (a check)
// npm run eval -- clips [--since yyyy-mm-dd]   the test shop's kept voice clips replayed and scored (D149)
// The held-out split is for the final run only (build step 9); the default is the open split. Voice recordings are
// read from the private recordings bucket with the project's secret key and converted with ffmpeg (spec 18.4).

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
  EVAL_SHOP_ID: z.uuid().optional(), // the test shop, whose recordings are under <shop_id>/eval/
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
  const report = buildReport(state.runId, scores, state.providers ?? null);
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
      style: { type: "string", default: "all" },
      kind: { type: "string" },
      ids: { type: "string" },
      limit: { type: "string" },
      "built-actions": { type: "string", default: "" },
      resume: { type: "boolean", default: false },
      run: { type: "string" },
      file: { type: "string" },
      as: { type: "string", default: "owner" },
      since: { type: "string" },
    },
  });
  const all = loadItems(join(root, "items.jsonl"));

  if (command === "score") {
    const runId = values.run ?? latestRun();
    const state = JSON.parse(readFileSync(join(runsDir, runId, "run-state.json"), "utf8")) as RunState;
    print(`report: ${writeReport(all, state)}`);
    return;
  }
  if (command !== "run" && command !== "say" && command !== "clips")
    throw new Error(`unknown command ${command}; use run, score, say or clips`);

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

  if (command === "clips") {
    if (!env.EVAL_SHOP_ID) throw new Error("clips needs EVAL_SHOP_ID, the test shop");
    const bucket = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    }).storage.from("recordings");
    const storage: ClipStorage = {
      async list(path) {
        const { data, error } = await bucket.list(path, { limit: 1000 });
        if (error) throw new Error(`listing ${path}: ${error.message}`);
        // A folder has no ID in Supabase Storage's listing.
        return data.map((entry) => ({
          name: entry.name,
          createdAt: entry.created_at ?? null,
          folder: !entry.id,
        }));
      },
      async download(path) {
        const { data, error } = await bucket.download(path);
        if (error || !data) throw new Error(`downloading ${path}: ${error?.message ?? "no data"}`);
        return new Uint8Array(await data.arrayBuffer());
      },
    };
    const labels = loadClipLabels(join(root, "clip-labels.jsonl"));
    const session = sessions.owner;
    const results: ClipResult[] = [];
    for (const group of await keptConversations(storage, env.EVAL_SHOP_ID, values.since ?? null)) {
      print(`conversation ${group.conversation}: ${group.clips.length} clips`);
      const conversation = await session.newConversation("voice");
      for (const clip of group.clips) {
        const label = labels.get(clip);
        if (label?.confirms) {
          print(`  – not sent: "${label.meant}" confirms a write, which a replay never saves again`);
          continue;
        }
        const turn = await session.voice(conversation, await toPcm16k(await storage.download(clip)), {
          realTime: false,
        });
        const result = scoreClip(clip, turn, label);
        results.push(result);
        const mark = result.passed === undefined ? "·" : result.passed ? "✓" : "×";
        const missing = result.missing?.length ? `  [missing: ${result.missing.join(", ")}]` : "";
        const unwanted = result.unwanted?.length ? `  [wrong: ${result.unwanted.join(", ")}]` : "";
        print(`  ${mark} ${turn.transcript ?? "(nothing heard)"} → ${turn.reply}${missing}${unwanted}`);
      }
    }
    const runId = `clips-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    mkdirSync(join(runsDir, runId), { recursive: true });
    const summary = summarize(results);
    writeFileSync(join(runsDir, runId, "clips.json"), JSON.stringify({ summary, results }, null, 2));
    print(
      `${summary.clips} clips: ${summary.askedAgain} asked again; ${summary.passed} of ${summary.labelled} labelled ` +
        `clips right. Saved in tools/eval/runs/${runId}`,
    );
    return;
  }

  if (command === "say") {
    if (!values.file) throw new Error("say needs --file <audio file>");
    const session = values.as === "staff" ? sessions.staff : sessions.owner;
    const pcm = await toPcm16k(readFileSync(values.file));
    print(`sending ${(pcm.byteLength / 32_000).toFixed(1)} s of audio as a voice question, in real time`);
    const turn = await session.voice(await session.newConversation("voice"), pcm, { realTime: true });
    print(`heard:  ${turn.transcript ?? "(no transcript)"}`);
    print(`answer: ${turn.reply}`);
    print(
      `state ${turn.state}; first text ${turn.firstTextMs} ms, first audio ${turn.firstAudioMs ?? "-"} ms after release; ` +
        `server ${JSON.stringify(turn.timings ?? {})}${turn.errors.length ? `; errors ${turn.errors.join(", ")}` : ""}`,
    );
    return;
  }

  // Voice recordings: <shop_id>/eval/<item>.wav in the private recordings bucket (D41), as 16 kHz mono PCM.
  const storage = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage.from("recordings");
  const loadClip: LoadClip = async (item) => {
    if (!item.audio || !env.EVAL_SHOP_ID) return null;
    const path = item.audio.replace(/^recordings\//, "").replace("<shop_id>", env.EVAL_SHOP_ID);
    const { data, error } = await storage.download(path);
    if (error || !data) return null;
    return toPcm16k(new Uint8Array(await data.arrayBuffer()));
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
        (values.style === "all" || item.script_style === values.style) &&
        (!kinds || kinds.includes(item.kind)) &&
        (!ids || ids.includes(item.id)),
    );
    if (values.limit) chosen = chosen.slice(0, Number(values.limit));
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    state = {
      runId,
      startedAt: new Date().toISOString(),
      providers: await sessions.owner.providers(),
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
  const finished = await runItems(items, state, sessions, save, print, loadClip);
  if (finished.stopped) {
    print(`stopped: ${finished.stopped.reason}. Continue after 00:00 UTC with: npm run eval -- run --resume`);
  }
  print(`report: ${writeReport(all, finished)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
