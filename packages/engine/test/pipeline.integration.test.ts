import type { ReplyEvent } from "@dokaanbondhu/contracts";
import { buildDictionary, CANNOT_ANSWER_NOW, SEE_IN_APP } from "@dokaanbondhu/core";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTurn, type TurnDeps, type TurnState } from "../src/conversation/turn";
import { readCatalog, toCatalog, type Catalog } from "../src/host/catalog";
import { HostPools, type HostDb } from "../src/host/pool";
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
      formulas: [],
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

  const padsQuestion = {
    part_type: "সামনের ব্রেক প্যাড",
    vehicle: "এক্সিও",
    year: "২০১৪",
    position: "সামনের",
  };
  const phrased =
    "এক্সিও ২০১৪-এর সামনের প্যাড দুই রকম আছে: জেনুইন ৩ সেট, ৪,৫০০ টাকা; নন-জেনুইন ৬ সেট, ১,৮০০ টাকা। দুটোই B-3 তাকে।";

  it("answers the architecture's A.1 with grounded LLM text, part cards, and two LLM calls", async () => {
    const llm = scripted([{ calls: [{ name: "find_parts", arguments: padsQuestion }] }, { text: phrased }]);
    const { outcome, events, reply } = await turn("এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড আছে?", fresh(), [llm]);
    expect(reply).toBe(phrased);
    expect(events.find((event) => event.type === "cards")).toMatchObject({ parts: [{}, {}] });
    expect(events.at(-1)).toMatchObject({ type: "done", state: "IDLE" });
    expect(outcome.meta).toMatchObject({ llm_calls: 2, grounding_failures: 0 });
    expect(outcome.state.context.vehicle).toMatchObject({ model: "Toyota Axio", year: 2014 });
  });

  it("drops an invented price and says the template answer instead", async () => {
    const llm = scripted([
      { calls: [{ name: "find_parts", arguments: padsQuestion }] },
      { text: "এক্সিও ২০১৪-এর জেনুইন প্যাড ৫,০০০ টাকা।" },
    ]);
    const { outcome, reply } = await turn("এক্সিও ২০১৪-এর সামনের প্যাড আছে?", fresh(), [llm]);
    expect(outcome.meta.grounding_failures).toBe(1);
    expect(reply).toContain("দুই রকম আছে");
    expect(reply).not.toContain("৫,০০০");
  });

  it("asks the year for a Noah starter, then answers the year without the LLM", async () => {
    const first = await turn("নোয়ার সেলফ আছে?", fresh(), [
      scripted([{ calls: [{ name: "find_parts", arguments: { part_type: "সেলফ", vehicle: "নোয়া" } }] }]),
    ]);
    expect(first.reply).toBe("কোন বছরের নোয়া?");
    expect(first.outcome.state).toMatchObject({ state: "CLARIFYING", frame: { asking: "year" } });
    expect(first.events.find((event) => event.type === "choices")).toMatchObject({
      slot: "year",
      options: expect.arrayContaining([{ id: expect.any(String), label: "2014–2021" }]),
    });
    const second = await turn("২০১৬", first.outcome.state, [scripted([])]);
    expect(second.outcome.meta.llm_calls).toBe(0);
    expect(second.reply).toContain("নোয়া ২০১৬-এর");
    expect(second.reply).toContain("জেনুইন");
    expect(second.outcome.state.state).toBe("IDLE");
  });

  it("asks which Rahim, then reads the chosen one's due through the guard", async () => {
    const first = await turn("রহিমের বাকি কত?", fresh(), [
      scripted([{ calls: [{ name: "resolve_customer", arguments: { name: "রহিম" } }] }]),
    ]);
    expect(first.reply).toMatch(/নাকি/);
    const choices = first.events.find((event) => event.type === "choices") as {
      options: { id: string; label: string }[];
    };
    const motors = choices.options.find((option) => option.label === "Rahim Motors")!;
    const second = await turn(
      undefined,
      first.outcome.state,
      [
        scripted([
          {
            calls: [
              {
                name: "run_read_query",
                arguments: {
                  sql: "SELECT name, due_balance FROM customers WHERE name = 'Rahim Motors'",
                  purpose: "বাকি",
                },
              },
            ],
          },
          { text: "রহিম মোটরসের বাকি ১৯,২০০ টাকা।" },
        ]),
      ],
      { slot: "customer", optionId: motors.id },
    );
    expect(second.reply).toBe("রহিম মোটরসের বাকি ১৯,২০০ টাকা।");
    expect(second.events.find((event) => event.type === "table")).toMatchObject({
      rows: [["Rahim Motors", 1920000]],
    });
    expect(second.outcome.state.context.customer).toMatchObject({ name: "Rahim Motors" });
  });

  it("sends profit to the app, and answers with the fixed message when every LLM is down", async () => {
    const profit = await turn("এই মাসে লাভ কত?", fresh(), [
      scripted([{ calls: [{ name: "get_report", arguments: { name: "profit_loss" } }] }]),
    ]);
    expect(profit.reply).toBe(SEE_IN_APP);
    const outage = await turn("এক্সিওর প্যাড আছে?", fresh(), [down]);
    expect(outage.reply).toBe(CANNOT_ANSWER_NOW);
  });
});
