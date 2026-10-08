import type { ReplyEvent } from "@dokaanbondhu/contracts";
import { buildDictionary, formatTaka, type ActionTemplate } from "@dokaanbondhu/core";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTurn, type TurnDeps, type TurnState } from "../src/conversation/turn";
import { callHost, type ApiConnection, type HostRequest } from "../src/host/api";
import { readCatalog, toCatalog, type Catalog } from "../src/host/catalog";
import { importOpenApi } from "../src/host/openapi-import";
import { HostPools, type HostDb } from "../src/host/pool";
import type { LlmDelta, LlmProvider, LlmRequest } from "../src/providers";
import { undoAction } from "../src/write/execute";
import type { ActionRecord, WriteCapability, WriteHost } from "../src/write/types";
import { geargridMap } from "./geargrid-map";
import { scripted, type Step } from "./scripted-llm";

// The write path end to end (spec 9.6, 9.9, 11.9, 11.10; D136): whole chat turns against the test host's API that the
// CI job starts on port 4000, read back through its read-only role. A sale, a payment and a stock-in are asked for,
// confirmed, saved, verified and undone; nothing is sent for real before yes. Every conversation in Bangla and in
// Banglish (D96). The capabilities come from the host's own OpenAPI document, as setup imports them.

const apiUrl = process.env.GEARGRID_API_URL ?? "";
const seedKey = process.env.SEED_API_KEY ?? "";
const migrationUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const local = (url: string) => {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};
const ready = local(apiUrl) && local(migrationUrl) && seedKey.length > 0;
if (process.env.CI === "true" && !ready)
  throw new Error("the write tests need the CI job's API and database");

/** Enabled in these tests: the three of step 5, and the price change, which only the owner may use. */
const ENABLED = new Set(["record_sale", "receive_payment", "stock_in", "update_price"]);

/** The capability registry as setup leaves it: every proposal confirmed, the writes above enabled (spec 11.8). */
function registryOf(document: unknown, calls: HostRequest[]): WriteHost {
  const imported = importOpenApi(document);
  const ids = new Map(imported.capabilities.map((capability) => [capability.name, randomUUID()]));
  const compensations = new Set(
    imported.capabilities
      .filter(
        (capability) => capability.compensation && capability.compensation.operation !== capability.name,
      )
      .map((capability) => capability.compensation!.operation),
  );
  const capabilities: WriteCapability[] = imported.capabilities
    .filter((capability) => capability.kind === "write" && ENABLED.has(capability.name))
    .filter((capability) => !compensations.has(capability.name))
    .map((capability) => ({
      id: ids.get(capability.name)!,
      name: capability.name,
      description: capability.description || null,
      template: capability.template as ActionTemplate,
      requiredRole: capability.requiredRole,
      httpMethod: capability.httpMethod,
      path: capability.path,
      dryRun: capability.supportsDryRun,
      params: capability.params.map((param) => ({
        path: param.path,
        location: param.location,
        type: param.type,
        required: param.required,
        enumValues: param.enumValues,
        entityConcept: param.entityConcept,
        semanticSlot: param.semanticSlot,
        spokenMap: param.spokenMap,
      })),
      compensation: capability.compensation
        ? {
            capabilityId: ids.get(capability.compensation.operation)!,
            operation: capability.compensation.operation,
            idFrom: capability.compensation.idFrom,
            body: capability.compensation.body,
          }
        : null,
      readBack: capability.readBack,
    }));
  const connection: ApiConnection = {
    id: "test-host-api",
    baseUrl: apiUrl,
    authType: "api_key",
    authHeader: "X-Api-Key",
    secret: seedKey,
    features: imported.features,
  };
  return {
    capabilities,
    operations: Object.fromEntries(
      imported.capabilities.map((capability) => [
        capability.name,
        {
          id: ids.get(capability.name)!,
          name: capability.name,
          httpMethod: capability.httpMethod,
          path: capability.path,
        },
      ]),
    ),
    features: imported.features,
    call: (request) => {
      calls.push(request);
      return callHost(connection, request);
    },
  };
}

/** A scripted LLM that also keeps the tool names it was offered. */
function watched(steps: Step[]): LlmProvider & { offered: string[][] } {
  const inner = scripted(steps);
  const llm = {
    id: inner.id,
    external: false,
    offered: [] as string[][],
    stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmDelta> {
      llm.offered.push((request.tools ?? []).map((tool) => tool.function.name));
      return inner.stream(request, signal);
    },
  };
  return llm;
}

describe.skipIf(!ready)("the write path on the test host's API", () => {
  const pools = new HostPools();
  const dictionary = buildDictionary();
  const calls: HostRequest[] = [];
  let db: HostDb;
  let catalog: Catalog;
  let writes: WriteHost;
  const fresh = (): TurnState => ({ state: "IDLE", context: {}, frame: null, history: [] });

  const deps = (llm: LlmProvider[], role: "owner" | "staff" = "staff"): TurnDeps => ({
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
      writes,
    },
    now: () => new Date(),
    newId: () => randomUUID(),
    evalMode: false,
    shopWords: [],
    role,
    actingUser: "Test Staff",
  });

  /** One chat turn: its reply, events and outcome; the next turn starts from its state. */
  async function say(
    state: TurnState,
    input: string | { choice: { slot: string; optionId: string } },
    llm: LlmProvider[] = [scripted([])],
  ) {
    const events: ReplyEvent[] = [];
    const outcome = await runTurn(
      typeof input === "string" ? { text: input } : input,
      state,
      deps(llm),
      (event) => events.push(event),
    );
    const reply = events
      .filter((event) => event.type === "text")
      .map((event) => (event as { text: string }).text)
      .join(" ");
    return { reply, events, outcome, state: outcome.state };
  }

  /** A balance as the host has it now, read through the read-only role. */
  async function balance(table: "customers" | "suppliers", name: string): Promise<bigint> {
    const column = table === "customers" ? "due_balance" : "payable_balance";
    const [row] = await pools.readOnly(db, (run) =>
      run({ text: `select ${column} as taka from ${table} where name = $1`, values: [name] }),
    );
    return BigInt(String(row!.taka));
  }

  /** Every call sent so far went as a dry run, or was a read: nothing was saved. */
  const nothingSent = () => calls.every((call) => call.method === "GET" || call.query?.dry_run === "true");

  /** Undo of a done action, as the history page's button asks for it (spec 11.9.1). */
  async function undo(record: ActionRecord, pending: { preview: NonNullable<ActionRecord["preview"]> }) {
    const capability = writes.capabilities.find((item) => item.id === record.capabilityId)!;
    return undoAction({
      capability,
      done: { response: record.response, preview: pending.preview },
      host: writes,
      actingUser: "Test Staff",
      idempotencyKey: randomUUID(),
    });
  }

  beforeAll(async () => {
    const url = new URL(migrationUrl);
    db = {
      id: "geargrid-ci-writes",
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
    const document = await (await fetch(new URL("/api/openapi.json", apiUrl))).json();
    writes = registryOf(document, calls);
  });

  afterAll(async () => {
    await pools.closeAll();
  });

  it("offers each write to the roles it allows, and never a compensation (spec 9.6, D52)", async () => {
    const staff = watched([{ calls: [{ name: "cannot_help", arguments: {} }] }]);
    await runTurn({ text: "hello" }, fresh(), deps([staff]), () => {});
    const owner = watched([{ calls: [{ name: "cannot_help", arguments: {} }] }]);
    await runTurn({ text: "hello" }, fresh(), deps([owner], "owner"), () => {});
    const writesOf = (names: string[]) =>
      names.filter((name) => ENABLED.has(name) || /void|reverse/.test(name));
    expect(writesOf(staff.offered[0]!).sort()).toEqual(["receive_payment", "record_sale", "stock_in"]);
    expect(writesOf(owner.offered[0]!).sort()).toEqual([
      "receive_payment",
      "record_sale",
      "stock_in",
      "update_price",
    ]);
  });

  it.each([
    {
      style: "Bangla",
      text: "রহিম মোটরসকে এক্সিওর সামনের ব্রেক প্যাড বাকিতে দাও",
      args: {
        customer: "রহিম মোটরস",
        items: [{ part: { part_type: "সামনের ব্রেক প্যাড", vehicle: "এক্সিও", position: "সামনের" } }],
        payment: { method_word: "বাকিতে" },
      },
      party: "রহিম মোটরস",
      answers: ["২০১৪", "নন-জেনুইন", "দুই সেট", "হ্যাঁ"],
    },
    {
      style: "Banglish",
      text: "Rahim Motors ke axior samner brake pad bakite dao",
      args: {
        customer: "Rahim Motors",
        items: [{ part: { part_type: "brake pad", vehicle: "axio", position: "samner" } }],
        payment: { method_word: "bakite" },
      },
      party: "Rahim Motors",
      answers: ["2014", "non genuine", "dui set", "ha"],
    },
  ])(
    "A.6: a credit sale asks the year, then the quality, then the quantity; it is saved on yes, verified and undone ($style)",
    async ({ text, args, party, answers }) => {
      calls.length = 0;
      const due = await balance("customers", "Rahim Motors");
      const first = await say(fresh(), text, [
        scripted([{ calls: [{ name: "record_sale", arguments: args }] }]),
      ]);
      expect(first.reply).toBe(`${party}, এক্সিওর সামনের ব্রেক প্যাড — কোন বছরের এক্সিও?`);
      const year = await say(first.state, answers[0]!);
      expect(year.reply).toBe("জেনুইন না নন-জেনুইন?");
      expect(year.events.find((event) => event.type === "choices")).toMatchObject({ slot: "quality" });
      const quality = await say(year.state, answers[1]!);
      expect(quality.reply).toBe("কয় সেট?");
      const quantity = await say(quality.state, answers[2]!);
      expect(quantity.reply).toBe(
        "Rahim Motors — এক্সিও ২০১৪, সামনের ব্রেক প্যাড, নন-জেনুইন, ২ সেট, ৩,২০০ টাকা, বাকিতে। ঠিক আছে?",
      );
      const confirm = quantity.events.find((event) => event.type === "confirm");
      expect(confirm).toMatchObject({
        type: "confirm",
        fields: expect.arrayContaining([{ label: "কাস্টমার", value: "Rahim Motors", highlight: false }]),
      });
      expect(quantity.outcome.actions).toEqual([expect.objectContaining({ status: "pending" })]);
      expect(quantity.events.at(-1)).toMatchObject({ type: "done", state: "CONFIRMING" });
      expect(nothingSent()).toBe(true); // only dry runs before yes (spec 9.9)
      expect(await balance("customers", "Rahim Motors")).toBe(due);

      const yes = await say(quantity.state, answers[3]!);
      expect(yes.reply).toBe(
        `হয়ে গেছে। Rahim Motors-এর মোট বাকি এখন ${formatTaka(due + 3200n)} টাকা। ব্রেক প্যাড B-3 তাকে আছে।`,
      );
      const done = yes.outcome.actions[0]!;
      expect(done).toMatchObject({ status: "done", verifyStatus: "ok" });
      expect(yes.events.find((event) => event.type === "action_result")).toMatchObject({
        status: "done",
        undo_available: true,
      });
      expect(yes.events.at(-1)).toMatchObject({ type: "done", state: "IDLE" });
      expect(calls.filter((call) => call.method === "POST" && !call.query?.dry_run)).toHaveLength(1);
      expect(await balance("customers", "Rahim Motors")).toBe(due + 3200n);

      const undone = await undo(done, { preview: quantity.outcome.actions[0]!.preview! });
      expect(undone).toMatchObject({ status: "undone" });
      expect(undone!.text).toBe(
        `আগের কাজটা ফিরিয়ে নেওয়া হয়েছে। Rahim Motors-এর মোট বাকি এখন ${formatTaka(due)} টাকা।`,
      );
      expect(await balance("customers", "Rahim Motors")).toBe(due);
    },
  );

  it.each([
    {
      style: "Bangla",
      text: "রহিম থেকে ১০ হাজার টাকা জমা নাও",
      args: { customer: "রহিম", amount: "১০ হাজার" },
      yes: "জ্বি",
    },
    {
      style: "Banglish",
      text: "Rahim theke 10 hajar taka joma nao",
      args: { customer: "Rahim", amount: "10 hajar" },
      yes: "ji",
    },
  ])(
    "A.3: a payment from one of two Rahims is asked, confirmed in cash, saved and undone ($style)",
    async ({ text, args, yes }) => {
      calls.length = 0;
      const due = await balance("customers", "Rahim Motors");
      const first = await say(fresh(), text, [
        scripted([{ calls: [{ name: "receive_payment", arguments: args }] }]),
      ]);
      expect(first.reply).toBe("Rahim Motors নাকি Rahim Auto Garage?");
      const choice = first.events.find((event) => event.type === "choices") as Extract<
        ReplyEvent,
        { type: "choices" }
      >;
      const picked = choice.options.find((option) => option.label === "Rahim Motors")!;
      const confirmed = await say(first.state, { choice: { slot: "customer", optionId: picked.id } });
      expect(confirmed.reply).toBe("Rahim Motors থেকে ১০,০০০ টাকা জমা, নগদ। ঠিক আছে?");
      expect(nothingSent()).toBe(true);
      const saved = await say(confirmed.state, yes);
      expect(saved.reply).toBe(`জমা হয়েছে। Rahim Motors-এর বাকি এখন ${formatTaka(due - 10_000n)} টাকা।`);
      expect(saved.outcome.actions[0]).toMatchObject({ status: "done", verifyStatus: "ok" });
      const undone = await undo(saved.outcome.actions[0]!, {
        preview: confirmed.outcome.actions[0]!.preview!,
      });
      expect(undone!.text).toBe(
        `আগের কাজটা ফিরিয়ে নেওয়া হয়েছে। Rahim Motors-এর বাকি এখন ${formatTaka(due)} টাকা।`,
      );
    },
  );

  it.each([
    {
      style: "Bangla",
      text: "নবাবপুর অটো পার্টস থেকে এক্সিও ২০১৪ সামনের নন-জেনুইন ব্রেক প্যাড ৫ সেট কিনলাম, প্রতি সেট ১২০০ টাকা, বাকিতে",
      args: {
        supplier: "নবাবপুর অটো পার্টস",
        items: [
          {
            part: {
              part_type: "ব্রেক প্যাড",
              vehicle: "এক্সিও",
              year: "২০১৪",
              position: "সামনের",
              quality: "নন-জেনুইন",
            },
            quantity: "৫ সেট",
            unit_cost: "১২০০",
          },
        ],
        payment: { method_word: "বাকিতে" },
      },
      correction: "না, ৪ সেট",
      yes: "হ্যাঁ, ঠিক আছে",
    },
    {
      style: "Banglish",
      text: "Nawabpur Auto Parts theke axio 2014 samner non genuine brake pad 5 set kinlam, proti set 1200 taka, bakite",
      args: {
        supplier: "Nawabpur Auto Parts",
        items: [
          {
            part: {
              part_type: "brake pad",
              vehicle: "axio",
              year: "2014",
              position: "samner",
              quality: "non genuine",
            },
            quantity: "5 set",
            unit_cost: "1200",
          },
        ],
        payment: { method_word: "bakite" },
      },
      correction: "na, 4 set",
      yes: "ha thik ache",
    },
  ])(
    "a stock-in with its unit cost; a correction confirms again; yes saves it ($style)",
    async ({ text, args, correction, yes }) => {
      calls.length = 0;
      const supplier = "Nawabpur Auto Parts Ltd.";
      const payable = await balance("suppliers", supplier);
      const first = await say(fresh(), text, [
        scripted([{ calls: [{ name: "stock_in", arguments: args }] }]),
      ]);
      expect(first.reply).toBe(
        `${supplier} থেকে ব্রেক প্যাড, ৫ সেট, প্রতি সেট ১,২০০ টাকা, মোট ৬,০০০ টাকা। ঠিক আছে?`,
      );
      const corrected = await say(first.state, correction);
      expect(corrected.reply).toBe(
        `${supplier} থেকে ব্রেক প্যাড, ৪ সেট, প্রতি সেট ১,২০০ টাকা, মোট ৪,৮০০ টাকা। ঠিক আছে?`,
      );
      expect(corrected.outcome.actions.map((action) => action.status)).toEqual(["cancelled", "pending"]);
      expect(nothingSent()).toBe(true);
      const saved = await say(corrected.state, yes);
      expect(saved.reply).toBe(`হয়ে গেছে। ${supplier}-এর পাওনা এখন ${formatTaka(payable + 4800n)} টাকা।`);
      expect(saved.outcome.actions[0]).toMatchObject({ status: "done", verifyStatus: "ok" });
      const undone = await undo(saved.outcome.actions[0]!, {
        preview: corrected.outcome.actions[1]!.preview!,
      });
      expect(undone).toMatchObject({ status: "undone" });
      expect(await balance("suppliers", supplier)).toBe(payable);
    },
  );

  it.each([
    {
      style: "Bangla",
      text: "রহিম মোটরসকে এক্সিও ২০১৪ সামনের জেনুইন ব্রেক প্যাড এক সেট নগদে দাও",
      no: "না",
      party: "রহিম মোটরস",
    },
    {
      style: "Banglish",
      text: "Rahim Motors ke axio 2014 samner genuine brake pad ek set nogode dao",
      no: "batil",
      party: "Rahim Motors",
    },
  ])("no cancels a confirmation and nothing is saved ($style)", async ({ text, no, party }) => {
    calls.length = 0;
    const args = {
      customer: party,
      items: [
        {
          part: {
            part_type: "brake pad",
            vehicle: "axio",
            year: "2014",
            position: "front",
            quality: "genuine",
          },
          quantity: text.includes("এক") ? "এক সেট" : "ek set",
        },
      ],
      payment: { method_word: text.includes("নগদে") ? "নগদে" : "nogode" },
    };
    const first = await say(fresh(), text, [
      scripted([{ calls: [{ name: "record_sale", arguments: args }] }]),
    ]);
    expect(first.reply).toMatch(
      /^Rahim Motors — এক্সিও ২০১৪, সামনের ব্রেক প্যাড, জেনুইন, ১ সেট, .+ টাকা, নগদ। ঠিক আছে\?$/,
    );
    const cancelled = await say(first.state, no);
    expect(cancelled.reply).toBe("বাতিল করা হয়েছে, কিছু সেভ হয়নি।");
    expect(cancelled.outcome.actions).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(cancelled.events.find((event) => event.type === "action_result")).toMatchObject({
      status: "cancelled",
    });
    expect(nothingSent()).toBe(true);
  });
});
