import type { ReplyEvent } from "@dokaanbondhu/contracts";
import {
  buildDictionary,
  CANNOT_ANSWER_NOW,
  formatTaka,
  helpAnswer,
  SEE_IN_APP,
  SEE_ON_SCREEN,
} from "@dokaanbondhu/core";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTurn, type TurnDeps, type TurnState } from "../src/conversation/turn";
import { readCatalog, toCatalog, type Catalog } from "../src/host/catalog";
import { HostPools, type HostDb } from "../src/host/pool";
import { stockValue } from "../src/host/reports";
import type { LlmDelta, LlmProvider } from "../src/providers";
import { geargridMap } from "./geargrid-map";

// Pipeline tests (spec 18.1): whole chat turns against the CI copy of GearGrid, with a scripted LLM, so every LLM
// call is known: the tool it chooses and the sentence it phrases.

const migrationUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const isLocal = (() => {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(migrationUrl).hostname);
  } catch {
    return false;
  }
})();

interface Step {
  text?: string;
  calls?: { name: string; arguments: Record<string, unknown> }[];
}

/** An LLM that answers from a script, one step per call, and fails the test when called beyond it. */
function scripted(steps: Step[]): LlmProvider & { calls: number } {
  const llm = {
    id: "stub",
    external: false,
    calls: 0,
    async *stream(): AsyncIterable<LlmDelta> {
      const step = steps[llm.calls];
      llm.calls += 1;
      if (!step) throw new Error("the LLM was called more often than the script allows");
      yield { type: "start" };
      if (step.text) yield { type: "text", text: step.text };
      if (step.calls?.length) {
        yield {
          type: "tool_calls",
          calls: step.calls.map((call, index) => ({
            id: `call-${index}`,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          })),
        };
      }
      yield { type: "finish", reason: step.calls?.length ? "tool_calls" : "stop" };
    },
  };
  return llm;
}

const down: LlmProvider = {
  id: "down",
  external: false,
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<LlmDelta> {
    throw Object.assign(new Error("unavailable"), { status: 503 });
  },
};

describe.skipIf(!isLocal)("chat turn pipeline on GearGrid's seed", () => {
  const pools = new HostPools();
  let db: HostDb;
  let catalog: Catalog;
  const dictionary = buildDictionary();
  const fresh = (): TurnState => ({ state: "IDLE", context: {}, frame: null, history: [] });

  const deps = (llm: LlmProvider[]): TurnDeps => ({
    llm,
    dictionary,
    host: {
      map: geargridMap,
      run: (query) => pools.readOnly(db, (run) => run(query)),
      catalog,
      fitmentExtra: [],
      rackExtra: new Map(),
      // The stock-value formula as the owner confirms it in setup (spec 11.7).
      formulas: [
        {
          name: "stock_value",
          definition: { sum_of_product: ["StockItem.quantity", "Price.cost"] },
          confirmed: true,
        },
      ],
      hostReports: [],
    },
    now: () => new Date(),
    newId: () => randomUUID(),
    evalMode: true,
    shopWords: [],
  });

  async function turn(
    text: string | undefined,
    state: TurnState,
    llm: LlmProvider[],
    choice?: { slot: string; optionId: string },
  ) {
    const events: ReplyEvent[] = [];
    const outcome = await runTurn(
      { ...(text ? { text } : {}), ...(choice ? { choice } : {}) },
      state,
      deps(llm),
      (event) => events.push(event),
    );
    const reply = events
      .filter((event) => event.type === "text")
      .map((event) => (event as { text: string }).text)
      .join(" ");
    return { outcome, events, reply };
  }

  beforeAll(async () => {
    const url = new URL(migrationUrl);
    db = {
      id: "geargrid-ci",
      dialect: "postgres",
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.slice(1),
      username: "dokaanbondhu_ro",
      password: process.env.DOKAAN_RO_PASSWORD ?? "",
      sslMode: "disable",
      sslCa: null,
      poolMax: 2,
    };
    catalog = toCatalog(await pools.readOnly(db, (run) => readCatalog(run, geargridMap)));
  });

  afterAll(async () => {
    await pools.closeAll();
  });

  // Every conversation is tested as staff type it both ways, Bangla script and Banglish (D96); the LLM's tool
  // arguments follow the request's script, as Gemma passes them. Replies are always in Bangla.
  const a1Answer =
    "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড দুই রকম আছে: জেনুইন ৩ সেট, ৪,৫০০ টাকা; নন-জেনুইন ৬ সেট, ১,৮০০ টাকা। দুটোই B-3 তাকে।";

  it.each([
    {
      style: "Bangla",
      text: "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড আছে?",
      args: { part_type: "সামনের ব্রেক প্যাড", vehicle: "এক্সিও", year: "২০১৪", position: "সামনের" },
    },
    {
      style: "Banglish",
      text: "axio 2014 er samner brake pad ache?",
      args: { part_type: "brake pad", vehicle: "axio", year: "2014", position: "samner" },
    },
  ])(
    "answers the architecture's A.1 with the template, part cards, and one LLM call (D95; $style)",
    async ({ text, args }) => {
      const llm = scripted([{ calls: [{ name: "find_parts", arguments: args }] }]);
      const { outcome, events, reply } = await turn(text, fresh(), [llm]);
      expect(reply).toBe(a1Answer);
      expect(events.find((event) => event.type === "cards")).toMatchObject({ parts: [{}, {}] });
      expect(events.at(-1)).toMatchObject({ type: "done", state: "IDLE" });
      expect(outcome.meta).toMatchObject({ llm_calls: 1, grounding_failures: 0 });
      expect(outcome.state.context.vehicle).toMatchObject({ model: "Toyota Axio", year: 2014 });
    },
  );

  const rahimMotorsDue = {
    name: "run_read_query",
    arguments: {
      sql: "SELECT name, due_balance FROM customers WHERE name = 'Rahim Motors'",
      purpose: "বাকি",
    },
  };

  it.each([
    { style: "Bangla", text: "রহিম মোটরসের বাকি কত?" },
    { style: "Banglish", text: "rahim motors er baki koto?" },
  ])(
    "drops an invented figure from the LLM's words and says the template answer instead ($style)",
    async ({ text }) => {
      const llm = scripted([{ calls: [rahimMotorsDue] }, { text: "রহিম মোটরসের বাকি ২৫,০০০ টাকা।" }]);
      const { outcome, reply } = await turn(text, fresh(), [llm]);
      expect(outcome.meta.grounding_failures).toBe(1);
      expect(reply).toBe(SEE_ON_SCREEN);
    },
  );

  it.each([
    {
      style: "Bangla",
      text: "নোয়ার সেলফ আছে?",
      args: { part_type: "সেলফ", vehicle: "নোয়া" },
      year: "২০১৬",
    },
    {
      style: "Banglish",
      text: "noah er self ache?",
      args: { part_type: "self", vehicle: "noah" },
      year: "2016",
    },
  ])(
    "asks the year for a Noah starter, then answers the year without the LLM ($style)",
    async ({ text, args, year }) => {
      const first = await turn(text, fresh(), [
        scripted([{ calls: [{ name: "find_parts", arguments: args }] }]),
      ]);
      expect(first.reply).toBe("কোন বছরের নোয়া?");
      expect(first.outcome.state).toMatchObject({ state: "CLARIFYING", frame: { asking: "year" } });
      expect(first.events.find((event) => event.type === "choices")).toMatchObject({
        slot: "year",
        options: expect.arrayContaining([{ id: expect.any(String), label: "2014–2021" }]),
      });
      const second = await turn(year, first.outcome.state, [scripted([])]);
      expect(second.outcome.meta.llm_calls).toBe(0);
      expect(second.reply).toContain("নোয়া ২০১৬-এর");
      expect(second.reply).toContain("জেনুইন");
      expect(second.outcome.state.state).toBe("IDLE");
    },
  );

  it.each([
    { style: "Bangla", text: "রহিমের বাকি কত?", name: "রহিম" },
    { style: "Banglish", text: "rahim er baki koto?", name: "rahim" },
  ])(
    "asks which Rahim, then reads the chosen one's due through the guard ($style)",
    async ({ text, name }) => {
      const first = await turn(text, fresh(), [
        scripted([{ calls: [{ name: "resolve_customer", arguments: { name } }] }]),
      ]);
      expect(first.reply).toMatch(/নাকি/);
      const choices = first.events.find((event) => event.type === "choices") as {
        options: { id: string; label: string }[];
      };
      const motors = choices.options.find((option) => option.label === "Rahim Motors")!;
      const second = await turn(
        undefined,
        first.outcome.state,
        [scripted([{ calls: [rahimMotorsDue] }, { text: "রহিম মোটরসের বাকি ১৯,২০০ টাকা।" }])],
        { slot: "customer", optionId: motors.id },
      );
      expect(second.reply).toBe("রহিম মোটরসের বাকি ১৯,২০০ টাকা।");
      expect(second.events.find((event) => event.type === "table")).toMatchObject({
        rows: [["Rahim Motors", 19200]],
      });
      expect(second.outcome.state.context.customer).toMatchObject({ name: "Rahim Motors" });
    },
  );

  it.each([
    { style: "Bangla", profit: "এই মাসে লাভ কত?", pads: "এক্সিওর প্যাড আছে?" },
    { style: "Banglish", profit: "ei mase lav koto?", pads: "axio r pad ache?" },
  ])(
    "sends profit to the app, and answers with the fixed message when every LLM is down ($style)",
    async ({ profit, pads }) => {
      const report = await turn(profit, fresh(), [
        scripted([{ calls: [{ name: "get_report", arguments: { name: "profit_loss" } }] }]),
      ]);
      expect(report.reply).toBe(SEE_IN_APP);
      const outage = await turn(pads, fresh(), [down]);
      expect(outage.reply).toBe(CANNOT_ANSWER_NOW);
    },
  );

  it.each([
    {
      style: "Bangla",
      text: "এক্সিওর সামনের ব্রেক প্যাড আছে?",
      args: { part_type: "সামনের ব্রেক প্যাড", vehicle: "এক্সিও", position: "সামনের" },
      year: "২০১৪",
    },
    {
      style: "Banglish",
      text: "axio r front brake pad ache?",
      args: { part_type: "brake pad", vehicle: "axio", position: "front" },
      year: "2014",
    },
  ])(
    "asks the year for an Axio front pad said without one, then lists both kinds for 2014 (A.6, the read half; $style)",
    async ({ text, args, year }) => {
      const first = await turn(text, fresh(), [
        scripted([{ calls: [{ name: "find_parts", arguments: args }] }]),
      ]);
      expect(first.reply).toBe("কোন বছরের এক্সিও?");
      expect(first.events.find((event) => event.type === "choices")).toMatchObject({
        slot: "year",
        options: [{ label: "2006–2011" }, { label: "2012–2017" }],
      });
      const second = await turn(year, first.outcome.state, [scripted([])]);
      expect(second.outcome.meta.llm_calls).toBe(0);
      expect(second.reply).toBe(a1Answer);
      expect(second.outcome.trace.lookups.at(-1)).toMatchObject({
        resolved: { vehicle: "Toyota Axio", year: 2014, position: "front" },
        result: "rows",
      });
    },
  );

  it.each([
    { style: "Bangla", text: "আজকে ঢাকায় বৃষ্টি হবে?", own: "হ্যাঁ, আজ বিকেলে বৃষ্টি হতে পারে।" },
    { style: "Banglish", text: "ajke dhakay bristi hobe?", own: "Ha, ajke bikele bristi hote pare." },
  ])(
    "answers a request it cannot handle with the fixed help answer, whatever the LLM says ($style)",
    async ({ text, own }) => {
      const { reply, outcome } = await turn(text, fresh(), [
        scripted([{ text: own }, { calls: [{ name: "cannot_help", arguments: {} }] }]),
      ]);
      expect(reply).toBe(helpAnswer());
      expect(outcome.trace.tool_calls.map((call) => call.name)).toEqual(["cannot_help"]);
      expect(outcome.meta.llm_calls).toBe(2);
    },
  );

  it.each([
    {
      style: "Bangla",
      text: "প্রোবক্স ২০১৩-এর এয়ার ফিল্টার কোন র‍্যাকে?",
      args: { part_type: "এয়ার ফিল্টার", vehicle: "প্রোবক্স", year: "২০১৩" },
    },
    {
      style: "Banglish",
      text: "probox 2013 er air filter kon rack e?",
      args: { part_type: "air filter", vehicle: "probox", year: "2013" },
    },
  ])(
    "asks once more, requiring a tool, when the LLM first answers in its own words (D95; $style)",
    async ({ text, args }) => {
      const llm = scripted([
        { text: "দুঃখিত, আমি জানি না।" },
        { calls: [{ name: "find_parts", arguments: args }] },
        { text: "" },
      ]);
      const { reply, outcome } = await turn(text, fresh(), [llm]);
      expect(reply).toContain("প্রোবক্স ২০১৩-এর");
      expect(reply).toContain("তাকে");
      expect(outcome.meta.llm_calls).toBe(2);
    },
  );

  it.each([
    {
      style: "Bangla",
      text: "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড আছে?",
      args: { part_type: "ব্রেক প্যাড", vehicle: "এক্সিও", year: "২০১৪", position: "সামনের" },
      rear: "পেছনেরটা?",
      genuine: "আর জেনুইনটা?",
    },
    {
      style: "Banglish",
      text: "axio 2014 er front brake pad ache?",
      args: { part_type: "brake pad", vehicle: "axio", year: "2014", position: "front" },
      rear: "pechoner ta?",
      genuine: "genuine ta?",
    },
  ])(
    "answers a short follow-up by changing the last search, without the LLM (spec 9.8, D95; $style)",
    async ({ text, args, rear, genuine }) => {
      const first = await turn(text, fresh(), [
        scripted([{ calls: [{ name: "find_parts", arguments: args }] }, { text: "" }]),
      ]);
      expect(first.reply).toContain("B-3");
      const second = await turn(rear, first.outcome.state, [scripted([])]);
      expect(second.outcome.meta.llm_calls).toBe(0);
      expect(second.reply).toContain("এক্সিও ২০১৪-এর পেছনের");
      expect(second.reply).toContain("B-4");
      // Only non-genuine rear shoes exist: said plainly, then what there is (D95).
      const third = await turn(genuine, second.outcome.state, [scripted([])]);
      expect(third.outcome.meta.llm_calls).toBe(0);
      expect(third.reply).toBe(
        "এক্সিও ২০১৪-এর পেছনের লাইনিং জেনুইন নেই। এক্সিও ২০১৪-এর পেছনের নন-জেনুইন লাইনিং ২ সেট আছে, ১,৫০০ টাকা, B-4 তাকে।",
      );
    },
  );

  it.each([
    { style: "Bangla", text: "স্টকের মোট দাম কত?" },
    { style: "Banglish", text: "stock er mot dam koto?" },
  ])(
    "says the stock value from the confirmed formula, in whole taka (spec 11.7, D92; $style)",
    async ({ text }) => {
      const expected = await pools.readOnly(db, (run) => stockValue(geargridMap, run));
      const { reply } = await turn(text, fresh(), [
        scripted([{ calls: [{ name: "get_report", arguments: { name: "stock_value" } }] }, { text: "" }]),
      ]);
      expect(reply).toBe(`স্টকের মোট দাম ${formatTaka(expected)} টাকা।`);
    },
  );

  it.each([
    { style: "Bangla", text: "কোন কোন মাল অর্ডার দিতে হবে?" },
    { style: "Banglish", text: "kon kon mal order dite hobe?" },
  ])(
    "shows a read query's rows as a table, money in whole taka and quantities as numbers, and says to look at it ($style)",
    async ({ text }) => {
      const sql =
        "SELECT p.name_en, s.quantity, p.retail_price FROM parts p JOIN stock_levels s ON s.part_id = p.id WHERE s.quantity <= p.reorder_level";
      const { reply, events } = await turn(text, fresh(), [
        scripted([
          { calls: [{ name: "run_read_query", arguments: { sql, purpose: "কম স্টক" } }] },
          { text: "" },
        ]),
      ]);
      expect(reply).toBe(SEE_ON_SCREEN);
      const table = events.find((event) => event.type === "table") as Extract<ReplyEvent, { type: "table" }>;
      expect(table.rows).toHaveLength(8);
      expect(table.columns.map((column) => column.kind)).toEqual(["text", "number", "money"]);
      for (const row of table.rows) expect(Number.isInteger(row[2])).toBe(true); // whole taka (D110)
    },
  );
  // From the first voice test on the emulator (D101): Whisper split "এক্সিও" into "এক জিও" and wrote the year in words.
  it.each([
    {
      style: "Bangla",
      text: "এক জিও দুই হাজার চৌদ্দ এর সামনে ব্রেকপ্যান আছে",
      // as Gemma passed it live: the part and position in English, the car as heard, the year here in words
      args: { part_type: "Brake Pad", vehicle: "এক জিও", year: "দুই হাজার চৌদ্দ", position: "front" },
    },
    {
      style: "Banglish",
      text: "axio dui hajar choddo er samne brake pad ache?",
      args: { part_type: "brake pad", vehicle: "axio", year: "dui hajar choddo", position: "samne" },
    },
  ])(
    "understands Axio as speech-to-text splits it and a year said in words, never another car (D101; $style)",
    async ({ text, args }) => {
      const llm = scripted([{ calls: [{ name: "find_parts", arguments: args }] }]);
      const { reply, outcome } = await turn(text, fresh(), [llm]);
      expect(reply).toBe(a1Answer);
      expect(outcome.state.context.vehicle).toMatchObject({ model: "Toyota Axio", year: 2014 });
    },
  );

  it.each([
    {
      style: "Bangla",
      text: "নোয়ার সেলফ আছে?",
      args: { part_type: "সেলফ", vehicle: "নোয়া" },
      year: "দুই হাজার ষোল",
    },
    {
      style: "Banglish",
      text: "noah er self ache?",
      args: { part_type: "self", vehicle: "noah" },
      year: "dui hajar sholo",
    },
  ])(
    "takes a year said in words as the answer to the year question, not 2002 (D101; $style)",
    async ({ text, args, year }) => {
      const first = await turn(text, fresh(), [
        scripted([{ calls: [{ name: "find_parts", arguments: args }] }]),
      ]);
      expect(first.reply).toBe("কোন বছরের নোয়া?");
      const second = await turn(year, first.outcome.state, [scripted([])]);
      expect(second.outcome.meta.llm_calls).toBe(0);
      expect(second.reply).toContain("নোয়া ২০১৬-এর");
    },
  );

  // D118: the mistakes seen in the voice test of 5 Oct, as the LLM made them.
  it.each([
    {
      style: "Bangla",
      text: "এক্সিও দুই হাজার দশ সামনের ব্রেক প্যাড আছে?",
      args: { part_type: "সামনের ব্রেক প্যাড", vehicle: "এক্সিও", position: "সামনের" },
    },
    {
      style: "Banglish",
      text: "Axio dui hajar dosh shamner brake pad ache?",
      args: { part_type: "brake pad", vehicle: "Axio", position: "front" },
    },
  ])(
    "takes the year from the request when the LLM leaves it out of find_parts (D118; $style)",
    async ({ text, args }) => {
      const { outcome, reply } = await turn(text, fresh(), [
        scripted([{ calls: [{ name: "find_parts", arguments: args }] }]),
      ]);
      expect(outcome.meta.questions).toBe(0);
      expect(reply).toContain("এক্সিও ২০১০-এর");
      expect(reply).toContain("B-2");
    },
  );

  it.each([
    { style: "Bangla", text: "নোয়া সেল মোটর আছে?", args: { vehicle: "Toyota Noah", year: "noa" } },
    { style: "Banglish", text: "noah sel motor ache?", args: { vehicle: "Toyota Noah", year: "noa" } },
  ])(
    "fills a part type the LLM left out from the request and asks a year it gave as noise (D118; $style)",
    async ({ text, args }) => {
      const { outcome, reply } = await turn(text, fresh(), [
        scripted([{ calls: [{ name: "find_parts", arguments: args }] }]),
      ]);
      expect(reply).toBe("কোন বছরের নোয়া?");
      expect(outcome.trace.lookups[0]?.resolved).toMatchObject({ part_type: "Starter Motor", year: null });
    },
  );

  it.each([
    { style: "Bangla", text: "নোয়া সেল মোটর আছে?", name: "নোয়া সেল মোটর" },
    { style: "Banglish", text: "noah sel motor ache?", name: "noah sel motor" },
  ])(
    "searches the part when the LLM looks up a customer that a part and a car were taken for (D118; $style)",
    async ({ text, name }) => {
      const { outcome, reply } = await turn(text, fresh(), [
        scripted([{ calls: [{ name: "resolve_customer", arguments: { name } }] }]),
      ]);
      expect(reply).toBe("কোন বছরের নোয়া?");
      expect(outcome.trace.lookups[0]?.resolved).toMatchObject({ part_type: "Starter Motor" });
    },
  );

  it.each([
    { style: "Bangla", text: "করিম অটোর বাকি কত?", name: "করিম অটো" },
    { style: "Banglish", text: "karim auto er baki koto?", name: "karim auto" },
  ])("still resolves a real customer's name as a customer (D118; $style)", async ({ text, name }) => {
    const { outcome } = await turn(text, fresh(), [
      scripted([{ calls: [{ name: "resolve_customer", arguments: { name } }] }, { text: "ঠিক আছে।" }]),
    ]);
    expect(outcome.trace.lookups).toEqual([]);
    expect(outcome.state.context.customer).toMatchObject({ name: "Karim Auto" });
  });

  const karimAutoDue = {
    name: "run_read_query",
    arguments: {
      sql: "SELECT name, due_balance FROM customers WHERE name = 'Karim Auto'",
      purpose: "বাকি",
    },
  };

  it.each([
    { style: "Bangla", text: "করিম অটোর বাকি কত?" },
    { style: "Banglish", text: "Karim Auto er baki koto?" },
  ])("writes an amount the LLM gave in ASCII digits with Bangla digits (D118; $style)", async ({ text }) => {
    const llm = scripted([{ calls: [karimAutoDue] }, { text: "Karim Auto এর বাকি আছে 21,900 টাকা।" }]);
    const { outcome, reply } = await turn(text, fresh(), [llm]);
    expect(outcome.meta.grounding_failures).toBe(0);
    expect(reply).toBe("Karim Auto এর বাকি আছে ২১,৯০০ টাকা।");
  });
});
