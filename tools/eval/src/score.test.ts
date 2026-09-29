import { CANNOT_ANSWER_NOW, SEE_IN_APP } from "@dokaanbondhu/core";
import { describe, expect, it } from "vitest";
import { itemSchema, type Item } from "./items";
import { DailyLimitReached, DONT_KNOW, notRunReason, runChatItem, runItems, type RunState } from "./run";
import {
  buildReport,
  renderMarkdown,
  scoreItem,
  wordErrors,
  type ItemResult,
  type Trace,
  type TurnRecord,
} from "./score";
import type { Session } from "./session";

// The scorer and runner with invented traces (spec 18.4; architecture 11.2): correct action and exact part, reads
// answered in text or a table, the zero rules, scripted answers, and the daily-limit stop.

const item = (value: Record<string, unknown>): Item =>
  itemSchema.parse({ channel: "chat", split: "open", task_card: "x", text: "x", ...value });

const trace = (value: Partial<Trace>): Trace => ({
  tool_calls: [],
  lookups: [],
  questions: [],
  answer: "",
  grounding_failures: 0,
  llm_calls: 1,
  fallbacks: [],
  ...value,
});

const turn = (value: Partial<TurnRecord>): TurnRecord => ({
  sent: "x",
  reply: "",
  state: "IDLE",
  slot: null,
  trace: trace({}),
  tables: [],
  cards: 0,
  errors: [],
  firstTextMs: 900,
  totalMs: 2400,
  ...value,
});

const done = (id: string, turns: TurnRecord[], unscripted = 0): ItemResult => ({
  id,
  status: "done",
  turns,
  unscripted,
});

const pads = item({
  id: "c-001",
  kind: "part_lookup",
  expected: {
    tool: "find_parts",
    params: { part_type: "Brake Pad", vehicle: "Toyota Axio", year: 2014, position: "front" },
    part_key: "04465-10010",
  },
});

const lookup = (year: number, numbers: string[][]) => ({
  resolved: { part_type: "Brake Pad", vehicle: "Toyota Axio", year, position: "front", quality: null },
  result: "rows" as const,
  parts: numbers,
});

describe("scoring", () => {
  it("scores a lookup correct when the understood request and the found part match", () => {
    const result = done("c-001", [
      turn({
        state: "CLARIFYING",
        slot: "year",
        trace: trace({ lookups: [{ ...lookup(2014, []), result: "ask" }] }),
      }),
      turn({ trace: trace({ lookups: [lookup(2014, [["0446510010", "04465 10010"], ["AN-101WK"]])] }) }),
    ]);
    expect(scoreItem(pads, result)).toMatchObject({
      scored: true,
      correct: true,
      exactPart: true,
      questions: 1,
    });
  });

  it("marks a wrong year and a missing part, with notes", () => {
    const score = scoreItem(
      pads,
      done("c-001", [turn({ trace: trace({ lookups: [lookup(2010, [["AN-101WK"]])] }) })]),
    );
    expect(score).toMatchObject({ correct: false, exactPart: false });
    expect(score.notes.join(" ")).toContain("not found");
  });

  it("finds a read's figures in the reply or in a table, money cells read as whole taka", () => {
    const due = item({
      id: "c-085",
      kind: "other_read",
      expected: { read: "customer_due", answer: { due_taka: 21900 } },
    });
    expect(scoreItem(due, done("c-085", [turn({ reply: "করিম অটোর বাকি ২১,৯০০ টাকা।" })])).correct).toBe(
      true,
    );
    const table = { columns: [{ key: "due_balance", kind: "money" }], rows: [[2190000]] };
    expect(
      scoreItem(due, done("c-085", [turn({ reply: "বিস্তারিত স্ক্রিনে দেখুন।", tables: [table] })])).correct,
    ).toBe(true);
    expect(scoreItem(due, done("c-085", [turn({ reply: "বাকি ২০,০০০ টাকা।" })])).correct).toBe(false);
    const profit = item({ id: "c-077", kind: "other_read", expected: { answer: "see_in_app" } });
    expect(scoreItem(profit, done("c-077", [turn({ reply: SEE_IN_APP })])).correct).toBe(true);
  });

  it("counts a list read right when every key is named or the table has as many rows", () => {
    const low = item({
      id: "c-098",
      kind: "other_read",
      expected: { read: "low_stock", answer: { part_keys: ["A-1", "B-2", "C-3"] } },
    });
    const table = { columns: [{ key: "name", kind: "text" }], rows: [["x"], ["y"], ["z"]] };
    expect(scoreItem(low, done("c-098", [turn({ tables: [table] })])).correct).toBe(true);
    expect(scoreItem(low, done("c-098", [turn({ tables: [{ ...table, rows: [["x"]] }] })])).correct).toBe(
      false,
    );
  });

  it("breaks a zero rule when a fitment not in the data is asserted, or when anything acts", () => {
    const fitment = item({
      id: "c-172",
      kind: "must_not_act",
      subkind: "no_recorded_fitment",
      expected: {
        must_not: ["assert_fitment", "write"],
        part_key: "AN-220WK",
        vehicle: "Nissan Bluebird Sylphy",
      },
    });
    const asserted = trace({
      lookups: [
        {
          resolved: {
            part_type: "AN-220WK",
            vehicle: "Nissan Bluebird Sylphy",
            year: 2011,
            position: null,
            quality: null,
          },
          result: "rows",
          parts: [["AN-220WK"]],
        },
      ],
    });
    expect(scoreItem(fitment, done("c-172", [turn({ trace: asserted })]))).toMatchObject({
      correct: false,
      zeroRules: ["fitment asserted that is not in the data"],
    });
    const declined = trace({ lookups: [{ ...asserted.lookups[0]!, result: "none", parts: [] }] });
    expect(scoreItem(fitment, done("c-172", [turn({ trace: declined })])).correct).toBe(true);
    const unknown = item({
      id: "c-171",
      kind: "must_not_act",
      subkind: "unknown_request",
      expected: { must_not: ["write"] },
    });
    const acted = trace({ tool_calls: [{ name: "delete_customers", arguments: {}, result: "done" }] });
    expect(scoreItem(unknown, done("c-171", [turn({ trace: acted })])).zeroRules).toHaveLength(1);
  });

  it("reports per channel and split, and names what was not scored", () => {
    const report = buildReport("r1", [
      scoreItem(
        pads,
        done("c-001", [turn({ trace: trace({ lookups: [lookup(2014, [["04465-10010"]])] }) })]),
      ),
      scoreItem(item({ id: "c-111", kind: "write", expected: { action: "sale" } }), {
        id: "c-111",
        status: "not_built",
        reason: "action sale is not built",
        turns: [],
        unscripted: 0,
      }),
    ]);
    expect(report.groups["chat open"]).toMatchObject({
      items: 2,
      scored: 1,
      correctRate: 100,
      medianFirstTextMs: 900,
    });
    expect(report.notScored).toEqual([{ id: "c-111", reason: "action sale is not built" }]);
    expect(renderMarkdown(report)).toContain("No zero rule broken");
  });

  it("reports chat items by writing style, so Bangla script and Banglish are measured alike (D96)", () => {
    const found = done("x", [turn({ trace: trace({ lookups: [lookup(2014, [["04465-10010"]])] }) })]);
    const missed = done("x", [turn({ trace: trace({ lookups: [lookup(2012, [])] }) })]);
    const report = buildReport("r1", [
      scoreItem({ ...pads, id: "c-001", script_style: "bangla" }, found),
      scoreItem({ ...pads, id: "c-002", script_style: "banglish" }, missed),
      scoreItem({ ...pads, id: "c-003", split: "held_out", script_style: "banglish" }, found),
      scoreItem({ ...pads, id: "v-001", channel: "voice" }, found),
    ]);
    expect(report.byStyle.bangla).toMatchObject({ items: 1, correctRate: 100 });
    expect(report.byStyle.banglish).toMatchObject({ items: 2, correctRate: 50 });
    expect(report.byStyle["banglish open"]).toMatchObject({ items: 1, correctRate: 0 });
    expect(Object.keys(report.byStyle)).not.toContain("null");
    expect(renderMarkdown(report)).toContain("## Chat by writing style");
  });

  it("measures the speech model's word error rate on the first transcript, and names the models in use", () => {
    expect(wordErrors("নোয়ার সেলফ আছে", "নোয়ার সেল আছে")).toEqual({ errors: 1, words: 3 });
    expect(wordErrors("এক্সিও ২০১৪ প্যাড", "এক্সিও 2014 প্যাড")).toEqual({ errors: 0, words: 3 }); // digits alike
    const voice = item({
      id: "v-1",
      channel: "voice",
      kind: "part_lookup",
      expected: pads.expected,
      reference_transcript: "এক্সিও ২০১৪ সামনের প্যাড আছে",
    });
    const heard = done("v-1", [
      turn({
        transcript: "এক্সিও ২০১৪ সামনে প্যাড আছে",
        trace: trace({ lookups: [lookup(2014, [["04465-10010"]])] }),
      }),
    ]);
    const report = buildReport("r1", [scoreItem(voice, heard)], {
      chat: ["cloudflare (gemma)", "deepseek (deepseek-flash)"],
      stt: "speech_worker",
      tts: "speech_worker",
    });
    expect(report.groups["voice open"]).toMatchObject({ werRate: 20 });
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("chat cloudflare (gemma) -> deepseek (deepseek-flash)");
    expect(markdown).toContain("| 20% |");
  });
});

describe("runner", () => {
  function fakeSession(replies: TurnRecord[]): Session & { sent: string[] } {
    const sent: string[] = [];
    return {
      sent,
      role: "staff",
      newConversation: async () => "conv",
      chat: async (_conversation: string, text: string) => {
        sent.push(text);
        return replies.shift()!;
      },
    } as unknown as Session & { sent: string[] };
  }

  it("answers questions from the script, and 'I don't know' when it has none", async () => {
    const session = fakeSession([
      turn({ state: "CLARIFYING", slot: "year" }),
      turn({ state: "CLARIFYING", slot: "engine" }),
      turn({ reply: "done" }),
    ]);
    const result = await runChatItem(
      item({
        id: "c-9",
        kind: "part_lookup",
        text: "প্যাড",
        expected: pads.expected,
        script: { year: "2014" },
      }),
      session,
    );
    expect(session.sent).toEqual(["প্যাড", "2014", DONT_KNOW]);
    expect(result).toMatchObject({ status: "done", unscripted: 1 });
  });

  it("stops at the daily limit instead of scoring the item", async () => {
    const limited = turn({
      reply: CANNOT_ANSWER_NOW,
      trace: trace({ fallbacks: ["cf: http 429 daily-limit"] }),
    });
    await expect(runChatItem(pads, fakeSession([limited]))).rejects.toBeInstanceOf(DailyLimitReached);
  });

  it("leaves unbuilt writes out", () => {
    const sale = item({ id: "c-111", kind: "write", expected: { action: "sale" } });
    expect(notRunReason(sale, [])).toMatchObject({ status: "not_built" });
    expect(notRunReason(sale, ["sale"])).toBeNull();
  });

  it("sends a voice item's recording as its first turn, the scripted answers as text, and skips one not recorded", async () => {
    const voiced: string[] = [];
    const session = {
      ...fakeSession([turn({ reply: "done" })]),
      newConversation: async (channel: string) => `conv-${channel}`,
      voice: async (conversation: string, pcm: Uint8Array) => {
        voiced.push(`${conversation}:${pcm.byteLength}`);
        return turn({ state: "CLARIFYING", slot: "year", transcript: "নোয়ার সেলফ আছে" });
      },
    } as unknown as Session & { sent: string[] };
    const noah = item({
      id: "v-7",
      channel: "voice",
      kind: "part_lookup",
      audio: "recordings/<shop_id>/eval/v-7.wav",
      expected: pads.expected,
      script: { year: "2016" },
    });
    const result = await runChatItem(noah, session, new Uint8Array(32_000));
    expect(voiced).toEqual(["conv-voice:32000"]);
    expect(session.sent).toEqual(["2016"]);
    expect(result.turns[0]?.transcript).toBe("নোয়ার সেলফ আছে");

    const state: RunState = {
      runId: "r",
      startedAt: "",
      itemIds: [],
      builtActions: [],
      nextIndex: 0,
      results: [],
    };
    const finished = await runItems(
      [noah],
      state,
      { owner: session, staff: session },
      () => {},
      () => {},
      async () => null,
    );
    expect(finished.results[0]).toMatchObject({ id: "v-7", status: "skipped", reason: "not recorded yet" });
  });
});
