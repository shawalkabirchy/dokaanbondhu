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
  type ActionTrace,
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

/** A sale of two sets of 04465-10010 to Rahim Motors on credit, as the trace names it. */
const saleAction = (value: Partial<ActionTrace> = {}): ActionTrace => ({
  capability: "record_sale",
  template: "sale",
  customer: "Rahim Motors",
  supplier: null,
  new_party: null,
  lines: [{ part_numbers: ["04465-10010", "AN-101WK-X"], quantity: 2 }],
  parts: [],
  vehicle: null,
  total: 3200,
  paid: 0,
  request: { method: "POST", path: "/api/v1/sales", body: { customer_id: "c1", items: [{ quantity: 2 }] } },
  ...value,
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

  it("counts a list of every quality with the expected part as right when the card leaves the quality out (D186)", () => {
    const coil = item({
      id: "c-003",
      kind: "part_lookup",
      expected: {
        tool: "find_parts",
        params: { part_type: "Ignition Coil", vehicle: "Toyota Premio", year: 2014, quality: "genuine" },
        part_key: "DNCO-0101",
      },
      script: { quality: "genuine" },
    });
    const listed = {
      resolved: {
        part_type: "Ignition Coil",
        vehicle: "Toyota Premio",
        year: 2014,
        position: null,
        quality: null,
      },
      result: "rows" as const,
      parts: [["DNCO-0101"], ["LOC-IGN-1"]],
    };
    expect(scoreItem(coil, done("c-003", [turn({ trace: trace({ lookups: [listed] }) })])).correct).toBe(
      true,
    );
    // Not when the expected part is missing from the list, nor when the card itself names the quality.
    const without = { ...listed, parts: [["LOC-IGN-1"]] };
    expect(scoreItem(coil, done("c-003", [turn({ trace: trace({ lookups: [without] }) })])).correct).toBe(
      false,
    );
    const named = item({ ...coil, id: "c-004", script: {} });
    expect(scoreItem(named, done("c-004", [turn({ trace: trace({ lookups: [listed] }) })])).correct).toBe(
      false,
    );
  });

  it("counts every side listed with the expected part as right when the card leaves the side out (D187)", () => {
    const light = item({
      id: "c-040",
      kind: "part_lookup",
      expected: {
        tool: "find_parts",
        params: { part_type: "Headlight", vehicle: "Toyota Axio", year: 2015, position: "left" },
        part_key: "LOC-HEA-1",
      },
      script: { position: "left" },
    });
    const listed = {
      resolved: { part_type: "Headlight", vehicle: "Toyota Axio", year: 2015, position: null, quality: null },
      result: "rows" as const,
      parts: [["LOC-HEA-1"], ["LOC-HEA-2"]],
    };
    expect(scoreItem(light, done("c-040", [turn({ trace: trace({ lookups: [listed] }) })])).correct).toBe(
      true,
    );
    const without = { ...listed, parts: [["LOC-HEA-2"]] };
    expect(scoreItem(light, done("c-040", [turn({ trace: trace({ lookups: [without] }) })])).correct).toBe(
      false,
    );
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
    const table = { columns: [{ key: "due_balance", kind: "money" }], rows: [[21900]] };
    expect(
      scoreItem(due, done("c-085", [turn({ reply: "বিস্তারিত স্ক্রিনে দেখুন।", tables: [table] })])).correct,
    ).toBe(true);
    expect(scoreItem(due, done("c-085", [turn({ reply: "বাকি ২০,০০০ টাকা।" })])).correct).toBe(false);
    const profit = item({ id: "c-077", kind: "other_read", expected: { answer: "see_in_app" } });
    expect(scoreItem(profit, done("c-077", [turn({ reply: SEE_IN_APP })])).correct).toBe(true);
  });

  it("scores which cars a part fits by the cars traced for its answer (D186)", () => {
    const fits = item({
      id: "c-079",
      kind: "other_read",
      expected: { read: "part_fits", answer: { vehicles: ["toyota-noah-2007", "toyota-voxy-2007"] } },
    });
    const traced = (cars: string[]) =>
      trace({
        lookups: [
          {
            resolved: { part_type: null, vehicle: null, year: null, position: null, quality: null },
            result: "rows",
            parts: [["DNO2-0143"]],
            cars,
          },
        ],
      });
    const reply = "DNO2-0143 (অক্সিজেন সেন্সর) ৮টা আছে। লাগে: নোয়া ২০০৭–২০১৩, ভক্সি ২০০৭–২০১৩।";
    expect(
      scoreItem(
        fits,
        done("c-079", [turn({ reply, trace: traced(["toyota-voxy-2007", "toyota-noah-2007"]) })]),
      ).correct,
    ).toBe(true);
    const missing = scoreItem(fits, done("c-079", [turn({ reply, trace: traced(["toyota-noah-2007"]) })]));
    expect(missing.correct).toBe(false);
    expect(missing.notes).toEqual(["cars toyota-noah-2007, not toyota-noah-2007, toyota-voxy-2007"]);
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

  it("breaks a zero rule when a fitment not in the data is asserted, or when anything is saved without a yes", () => {
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
    // Putting something on a sheet is wrong for a must-not-act item, but no zero rule: nothing was saved.
    const onSheet = trace({ action: saleAction() });
    expect(scoreItem(unknown, done("c-171", [turn({ trace: onSheet, state: "CONFIRMING" })]))).toMatchObject({
      correct: false,
      zeroRules: [],
    });
    // Saved in a turn the runner did not say yes in: a zero rule, whatever the item.
    const saved = turn({ actionResult: { status: "done", undoAvailable: true } });
    expect(scoreItem(unknown, done("c-171", [saved])).zeroRules).toEqual([
      "action saved without confirmation (1)",
    ]);
    expect(scoreItem(pads, done("c-001", [saved])).zeroRules).toHaveLength(1);
  });

  it("scores a write by the action on its sheet, saved on the runner's yes", () => {
    const sale = item({
      id: "c-111",
      kind: "write",
      expected: {
        action: "sale",
        slots: { customer: "Rahim Motors", quantity: 2, payment: "due" },
        part_key: "04465-10010",
      },
    });
    const sheet = turn({ state: "CONFIRMING", confirmId: "a1", trace: trace({ action: saleAction() }) });
    const yes = turn({ kind: "decision", actionResult: { status: "done", undoAvailable: true } });
    const undo = turn({ kind: "undo", actionResult: { status: "done", undoAvailable: false } });
    expect(scoreItem(sale, { ...done("c-111", [sheet, yes, undo]), undone: true })).toMatchObject({
      scored: true,
      correct: true,
      exactPart: true,
      zeroRules: [],
    });
    // A wrong quantity, another customer, or paid when it was on credit: wrong, with a note each.
    const wrong = turn({
      state: "CONFIRMING",
      trace: trace({
        action: saleAction({
          customer: "Rahim Auto Garage",
          lines: [{ part_numbers: ["04465-10010"], quantity: 3 }],
          paid: 4800,
        }),
      }),
    });
    const scored = scoreItem(sale, done("c-111", [wrong, yes]));
    expect(scored.correct).toBe(false);
    expect(scored.notes).toEqual([
      "customer Rahim Auto Garage, not Rahim Motors",
      "quantity 3, not 2",
      "paid 4800, not on credit",
    ]);
    // On the sheet but refused by the app, or never shown: wrong.
    const refused = turn({ kind: "decision", actionResult: { status: "failed", undoAvailable: false } });
    expect(scoreItem(sale, done("c-111", [sheet, refused])).notes).toContain("not saved: failed");
    expect(scoreItem(sale, done("c-111", [turn({})])).notes).toContain("no action on a sheet");
    // Saved but not undone: said, so the next run resets the test shop first.
    expect(scoreItem(sale, { ...done("c-111", [sheet, yes]), undone: false }).notes).toContain(
      "not undone: reset the test shop before the next run",
    );
  });

  it("checks an owner's price, a payment, a price change, a fitment and a new customer", () => {
    const priced = item({
      id: "c-147",
      kind: "write",
      as: "owner",
      expected: {
        action: "sale",
        slots: { customer: "Rahim Motors", quantity: 2, payment: "cash", unit_price: 1500 },
        part_key: "04465-10010",
      },
    });
    const pricedAction = saleAction({
      paid: 3000,
      total: 3000,
      request: {
        method: "POST",
        path: "/api/v1/sales",
        body: { items: [{ unit_price_taka: 1500 }], payments: [{ method: "cash", amount_taka: 3000 }] },
      },
    });
    const yes = turn({ kind: "decision", actionResult: { status: "done", undoAvailable: true } });
    const run = (expected: Item, action: ActionTrace) =>
      scoreItem(expected, done(expected.id, [turn({ state: "CONFIRMING", trace: trace({ action }) }), yes]));
    expect(run(priced, pricedAction).correct).toBe(true);
    expect(
      run(priced, { ...pricedAction, total: 3200, request: { ...pricedAction.request, body: {} } }).notes,
    ).toContain("price not 1500 each (total 3200)");

    const payment = item({
      id: "c-118",
      kind: "write",
      expected: { action: "payment", slots: { customer: "Janata Auto", amount: 8000, method: "cash" } },
    });
    const paid = saleAction({
      template: "payment",
      customer: "Janata Auto",
      lines: [],
      paid: 8000,
      request: { method: "POST", path: "/api/v1/payments", body: { amount_taka: 8000, method: "cash" } },
    });
    expect(run(payment, paid).correct).toBe(true);
    expect(
      run(payment, { ...paid, request: { ...paid.request, body: { amount_taka: 8000, method: "bkash" } } })
        .correct,
    ).toBe(false);

    const price = item({
      id: "c-121",
      kind: "write",
      as: "owner",
      expected: { action: "price_update", slots: { prices: { retail: 1100 } }, part_key: "LOC-TIE-1220" },
    });
    const changed = saleAction({
      template: "price_update",
      customer: null,
      lines: [],
      parts: [["LOC-TIE-1220"]],
      request: { method: "PATCH", path: "/api/v1/parts/p9/prices", body: { retail_price_taka: 1100 } },
    });
    expect(run(price, changed)).toMatchObject({ correct: true, exactPart: true });

    const fitment = item({
      id: "c-127",
      kind: "write",
      as: "owner",
      expected: {
        action: "add_fitment",
        slots: { vehicle: { model: "Toyota Corolla", year: 2001 } },
        part_key: "MZ90915010",
      },
    });
    const fitted = saleAction({
      template: "add_fitment",
      customer: null,
      lines: [],
      parts: [["MZ90915010"]],
      vehicle: { model: "Toyota Corolla", year_from: 2001 },
    });
    expect(run(fitment, fitted).correct).toBe(true);
    expect(run(fitment, { ...fitted, vehicle: { model: "Toyota Corolla", year_from: 2007 } }).correct).toBe(
      false,
    );

    // A new customer said in Bangla is written in Bangla: either spelling counts, a letter or two apart.
    const added = item({
      id: "v-116",
      channel: "voice",
      kind: "write",
      expected: {
        action: "add_customer",
        slots: {
          name: "Al-Amin Auto Garage",
          name_bn: "আল-আমিন অটো গ্যারেজ",
          party_type: "garage",
          phone: "01755-201101",
        },
      },
    });
    const party = (name: string) =>
      saleAction({
        template: "add_customer",
        customer: null,
        lines: [],
        new_party: { name, type: "garage", phone: "01755201101" },
      });
    expect(run(added, party("আলআমিন অটো গ্যারেজ")).correct).toBe(true);
    expect(run(added, party("Alamin Auto Garage")).correct).toBe(true);
    expect(run(added, party("Al-Amin Motors")).correct).toBe(false);
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

  it("says yes on a write item's sheet and undoes what was saved; no on any other item's sheet", async () => {
    const calls: string[] = [];
    const sheetSession = (undoAvailable: boolean) =>
      ({
        ...fakeSession([
          turn({ state: "CONFIRMING", confirmId: "a1", trace: trace({ action: saleAction() }) }),
        ]),
        decide: async (id: string, decision: string) => {
          calls.push(`${decision} ${id}`);
          return turn({
            kind: "decision",
            actionResult: { status: decision === "yes" ? "done" : "cancelled", undoAvailable },
          });
        },
        undo: async (id: string, conversation: string) => {
          calls.push(`undo ${id} in ${conversation}`);
          return turn({ kind: "undo", actionResult: { status: "done", undoAvailable: false } });
        },
      }) as unknown as Session & { sent: string[] };
    const sale = item({
      id: "c-111",
      kind: "write",
      expected: { action: "sale", slots: { quantity: 2 } },
      script: { confirm: "yes" },
    });
    expect(await runChatItem(sale, sheetSession(true))).toMatchObject({ undone: true });
    expect(calls).toEqual(["yes a1", "undo a1 in conv"]);
    // No undo to call: said, so the scorer reports it.
    calls.length = 0;
    expect(await runChatItem(sale, sheetSession(false))).toMatchObject({ undone: false });
    expect(calls).toEqual(["yes a1"]);
    // A must-not-act item that put something on a sheet: no.
    calls.length = 0;
    const unknown = item({ id: "c-171", kind: "must_not_act", expected: { must_not: ["write"] } });
    const result = await runChatItem(unknown, sheetSession(true));
    expect(calls).toEqual(["no a1"]);
    expect(result.undone).toBeUndefined();
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
