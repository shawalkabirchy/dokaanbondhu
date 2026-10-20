import type { ReplyEvent } from "@dokaanbondhu/contracts";
import {
  buildDictionary,
  catalogEntries,
  formatTaka,
  GLOSSARY,
  normalize,
  type ActionTemplate,
} from "@dokaanbondhu/core";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

/**
 * Enabled in these tests: the three of step 5, the return (D169), the price change, which only the owner may use, the
 * fitment (D172), and a new customer or supplier (D173).
 */
const ENABLED = new Set([
  "record_sale",
  "receive_payment",
  "stock_in",
  "record_return",
  "update_price",
  "add_fitment",
  "add_customer",
  "add_supplier",
]);

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
    role: "owner" | "staff" = "staff",
  ) {
    const events: ReplyEvent[] = [];
    const outcome = await runTurn(
      typeof input === "string" ? { text: input } : input,
      state,
      deps(llm, role),
      (event) => events.push(event),
    );
    const reply = events
      .filter((event) => event.type === "text")
      .map((event) => (event as { text: string }).text)
      .join(" ");
    for (const action of outcome.actions) {
      if (action.preview) previews.set(action.id, action.preview);
      if ((action.status === "done" || action.status === "review") && action.response)
        saved.set(action.id, action);
    }
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

  /** A part's stock as the host has it now, all its rows summed. */
  async function stockOf(partId: string): Promise<number> {
    const [row] = await pools.readOnly(db, (run) =>
      run({
        text: "select coalesce(sum(quantity), 0)::text as units from stock_levels where part_id = $1",
        values: [partId],
      }),
    );
    return Number(row!.units);
  }

  /** A part's retail price as the host has it now, whole taka. */
  async function retailOf(partId: string): Promise<bigint> {
    const [row] = await pools.readOnly(db, (run) =>
      run({ text: "select retail_price from parts where id = $1", values: [partId] }),
    );
    return BigInt(String(row!.retail_price));
  }

  /** Every call sent so far went as a dry run, or was a read: nothing was saved. */
  const nothingSent = () => calls.every((call) => call.method === "GET" || call.query?.dry_run === "true");

  /** Every action saved and not undone yet, with what its confirmation showed: undone after each test (below). */
  const saved = new Map<string, ActionRecord>();
  const previews = new Map<string, NonNullable<ActionRecord["preview"]>>();

  /** Undo of a done action, as the history page's button asks for it (spec 11.9.1). */
  async function undo(record: ActionRecord, pending: { preview: NonNullable<ActionRecord["preview"]> }) {
    saved.delete(record.id);
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

  // A test that fails after saving still undoes what it saved, so the seed stays as the other files expect it.
  afterEach(async () => {
    for (const record of [...saved.values()])
      await undo(record, { preview: previews.get(record.id)! }).catch(() => null);
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
    expect(writesOf(staff.offered[0]!).sort()).toEqual([
      "add_customer",
      "add_fitment",
      "add_supplier",
      "receive_payment",
      "record_return",
      "record_sale",
      "stock_in",
    ]);
    expect(writesOf(owner.offered[0]!).sort()).toEqual([
      "add_customer",
      "add_fitment",
      "add_supplier",
      "receive_payment",
      "record_return",
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
      // The customer is remembered from the first question on, like the car (D157).
      expect(first.state.context.customer?.name).toBe("Rahim Motors");
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

  // D167, the owner's sale of 15 Oct: the car and its year tapped. Each tap on a year asked the year again, as a tap
  // says no words, and the seed's Fielder 2006-2012 and 2012-2017 share 2012. Cancelled at the end, so nothing is saved.
  it.each([
    {
      style: "Bangla",
      text: "রহিম মোটরসকে দুই সেট ব্রেক প্যাড বাকিতে দাও",
      args: {
        customer: "রহিম মোটরস",
        items: [{ part: { part_type: "ব্রেক প্যাড" }, quantity: "দুই সেট" }],
        payment: { method_word: "বাকিতে" },
      },
      no: "না",
    },
    {
      style: "Banglish",
      text: "Rohim Motors ke dui set brake pad bakite dau",
      args: {
        customer: "Rohim Motors",
        items: [{ part: { part_type: "brake pad" }, quantity: "dui set" }],
        payment: { method_word: "bakite" },
      },
      no: "na",
    },
  ])(
    "D167: a credit sale whose car and year are tapped asks each once ($style)",
    async ({ text, args, no }) => {
      calls.length = 0;
      const tap = (reply: Awaited<ReturnType<typeof say>>, label: RegExp) => {
        const choices = reply.events.find((event) => event.type === "choices");
        const option =
          choices?.type === "choices" ? choices.options.find((o) => label.test(o.label)) : undefined;
        if (choices?.type !== "choices" || !option) throw new Error(`no ${label}: ${reply.reply}`);
        return { choice: { slot: choices.slot, optionId: option.id } };
      };
      const start = () =>
        say(fresh(), text, [scripted([{ calls: [{ name: "record_sale", arguments: args }] }])]);
      const first = await start();
      expect(first.reply).toMatch(/ব্রেক প্যাড — কোন গাড়ির\?$/);
      const fielder = await say(first.state, tap(first, /ফিল্ডার/));
      expect(fielder.reply).toBe("কোন বছরের ফিল্ডার?");
      const years = fielder.events.find((event) => event.type === "choices");
      expect(years?.type === "choices" && years.options.map((option) => option.label)).toEqual([
        "2006–2012",
        "2012–2017",
      ]);
      // The newer Fielder has one front pad: the sale is confirmed at once.
      const newer = await say(fielder.state, tap(fielder, /^2012–2017$/));
      expect(newer.reply).toMatch(
        /^Rahim Motors — ফিল্ডার ২০১২, সামনের ব্রেক প্যাড, জেনুইন, ২ সেট, [০-৯,]+ টাকা, বাকিতে। ঠিক আছে\?$/,
      );
      const cancelled = await say(newer.state, no);
      expect(cancelled.outcome.actions).toEqual([expect.objectContaining({ status: "cancelled" })]);
      // The older one has a genuine and a non-genuine pad: the quality is asked next, never the year again.
      const again = await start();
      const older = await say((await say(again.state, tap(again, /ফিল্ডার/))).state, {
        choice: { slot: "year", optionId: "opt-1" },
      });
      expect(older.reply).toBe("জেনুইন না নন-জেনুইন?");
      expect(nothingSent()).toBe(true);
    },
  );

  // D172, a fitment on the test host: the seed's Axio 2014 front non-genuine pad fits the Axio and the Premio, not the
  // Fielder. Said to fit the Fielder too, the Fielder's year is asked, the fit is saved verified, and undone, so the
  // seed ends as it began.
  it.each([
    {
      style: "Bangla",
      text: "এক্সিও ২০১৪-এর সামনের নন-জেনুইন ব্রেক প্যাড ফিল্ডারেও লাগে",
      args: {
        part: {
          part_type: "সামনের ব্রেক প্যাড",
          vehicle: "এক্সিও",
          year: "২০১৪",
          position: "সামনের",
          quality: "নন-জেনুইন",
        },
        vehicle: { model: "ফিল্ডার" },
      },
      yes: "হ্যাঁ",
    },
    {
      style: "Banglish",
      text: "axio 2014 er samner non genuine brake pad fielder eo lage",
      args: {
        part: {
          part_type: "brake pad",
          vehicle: "axio",
          year: "2014",
          position: "samner",
          quality: "non genuine",
        },
        vehicle: { model: "fielder" },
      },
      yes: "ha",
    },
  ])("D172: a fitment is added, saved verified, and undone ($style)", async ({ text, args, yes }) => {
    calls.length = 0;
    const tap = (reply: Awaited<ReturnType<typeof say>>, label: RegExp) => {
      const choices = reply.events.find((event) => event.type === "choices");
      const option =
        choices?.type === "choices" ? choices.options.find((o) => label.test(o.label)) : undefined;
      if (choices?.type !== "choices" || !option) throw new Error(`no ${label}: ${reply.reply}`);
      return { choice: { slot: choices.slot, optionId: option.id } };
    };
    const first = await say(fresh(), text, [
      scripted([{ calls: [{ name: "add_fitment", arguments: args }] }]),
    ]);
    expect(first.reply).toBe("কোন বছরের ফিল্ডার?");
    const sheet = await say(first.state, tap(first, /^2012–2017$/));
    expect(sheet.reply).toBe("এক্সিওর সামনের ব্রেক প্যাড, নন-জেনুইন — ফিল্ডার ২০১২–২০১৭-এ লাগে। যোগ করব?");
    const pending = sheet.outcome.actions[0]!;
    const body = pending.request!.body as { part_id: string; vehicle_id: string; verified: boolean };
    expect(body.verified).toBe(true);
    expect(calls).toHaveLength(0); // no dry run for a fitment: nothing is sent before yes
    const fits = async () => {
      const rows = await pools.readOnly(db, (run) =>
        run({
          text: "select verified from fitments where part_id = $1 and vehicle_id = $2 and deleted_at is null",
          values: [body.part_id, body.vehicle_id],
        }),
      );
      return rows.map((row) => row.verified);
    };
    expect(await fits()).toEqual([]);
    const done = await say(sheet.state, yes);
    expect(done.reply).toBe("হয়ে গেছে।");
    expect(done.outcome.actions[0]).toMatchObject({ status: "done" });
    expect(done.events.find((event) => event.type === "action_result")).toMatchObject({
      status: "done",
      undo_available: true,
    });
    expect(await fits()).toEqual([true]);
    const undone = await undo(done.outcome.actions[0]!, { preview: pending.preview! });
    expect(undone).toMatchObject({ status: "undone" });
    expect(await fits()).toEqual([]);
  });

  // D171, a price change on the test host, the owner's: the part asked as for a sale, the confirmation from and to,
  // the new price saved and read back, then undone from the host's previous prices, so the seed ends as it began.
  it.each([
    {
      style: "Bangla",
      text: "এক্সিওর সামনের ব্রেক প্যাডের দাম ১৯০০ টাকা করো",
      args: {
        part: { part_type: "সামনের ব্রেক প্যাড", vehicle: "এক্সিও", position: "সামনের" },
        prices: { retail: "১৯০০ টাকা" },
      },
      answers: ["২০১৪", "নন-জেনুইন", "হ্যাঁ"],
    },
    {
      style: "Banglish",
      text: "axio r samner brake pad er dam 1900 koro",
      args: {
        part: { part_type: "brake pad", vehicle: "axio", position: "samner" },
        prices: { retail: "1900" },
      },
      answers: ["2014", "non genuine", "ha"],
    },
  ])(
    "D171: the owner changes a price; it is saved, read back and undone ($style)",
    async ({ text, args, answers }) => {
      const [year, quality, yes] = answers as [string, string, string];
      calls.length = 0;
      const owner = (state: TurnState, input: string, llm: LlmProvider[] = [scripted([])]) =>
        say(state, input, llm, "owner");
      const first = await owner(fresh(), text, [
        scripted([{ calls: [{ name: "update_price", arguments: args }] }]),
      ]);
      expect(first.reply).toMatch(/কোন বছরের এক্সিও\?$/);
      const sheet = await owner((await owner(first.state, year)).state, quality);
      expect(sheet.reply).toMatch(
        /^এক্সিওর সামনের ব্রেক প্যাডের খুচরা দাম [০-৯,]+ টাকা থেকে ১,৯০০ টাকা। ঠিক আছে\?$/,
      );
      const pending = sheet.outcome.actions[0]!;
      const partId = pending.request!.path.split("/").at(-2)!;
      const before = await retailOf(partId);
      expect(pending.request).toMatchObject({ method: "PATCH", body: { retail_price_taka: 1900 } });
      expect(calls).toHaveLength(0); // no dry run for prices: nothing is sent before yes
      const done = await owner(sheet.state, yes);
      expect(done.reply).toBe("হয়ে গেছে।");
      expect(done.outcome.actions[0]).toMatchObject({ status: "done" });
      expect(done.events.find((event) => event.type === "action_result")).toMatchObject({
        status: "done",
        undo_available: true,
      });
      expect(await retailOf(partId)).toBe(1900n);
      const undone = await undo(done.outcome.actions[0]!, { preview: pending.preview! });
      expect(undone).toMatchObject({ status: "undone" });
      expect(await retailOf(partId)).toBe(before);
    },
  );

  it.each([
    { style: "Bangla", text: "এক্সিওর সামনের ব্রেক প্যাডের দাম ১৯০০ টাকা করো" },
    { style: "Banglish", text: "axio r samner brake pad er dam 1900 koro" },
  ])("D171: staff who ask for a price change are told only the owner may ($style)", async ({ text }) => {
    calls.length = 0;
    const reply = await say(fresh(), text, [scripted([])]);
    expect(reply.reply).toBe("দাম বদলাতে পারেন শুধু দোকানের মালিক।");
    expect(reply.outcome.actions).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  // D169, a return on the test host: a credit sale of two sets is saved, then each set comes back. The first is found
  // among Rahim Motors' sales of that pad (today's is the newest) and refunded off the due; the second is the line's
  // last, so its quantity is not asked. GearGrid has no undo for a return, and a sale with a return cannot be voided
  // (D29), so both sets come back and the seed's due and stock end as they began.
  it.each([
    {
      style: "Bangla",
      sale: "রহিম মোটরসকে এক্সিওর সামনের ব্রেক প্যাড বাকিতে দাও",
      saleArgs: {
        customer: "রহিম মোটরস",
        items: [{ part: { part_type: "সামনের ব্রেক প্যাড", vehicle: "এক্সিও", position: "সামনের" } }],
        payment: { method_word: "বাকিতে" },
      },
      back: "রহিম মোটরস এক্সিওর সামনের ব্রেক প্যাড এক সেট ফেরত দিয়েছে",
      again: "রহিম মোটরস এক্সিওর সামনের ব্রেক প্যাড ফেরত দিয়েছে",
      customer: "রহিম মোটরস",
      part: { part_type: "সামনের ব্রেক প্যাড", vehicle: "এক্সিও", position: "সামনের" },
      one: "এক সেট",
      answers: ["২০১৪", "নন-জেনুইন", "দুই সেট", "হ্যাঁ"],
    },
    {
      style: "Banglish",
      sale: "Rahim Motors ke axior samner brake pad bakite dao",
      saleArgs: {
        customer: "Rahim Motors",
        items: [{ part: { part_type: "brake pad", vehicle: "axio", position: "samner" } }],
        payment: { method_word: "bakite" },
      },
      back: "Rahim Motors axio r samner brake pad ek set ferot dise",
      again: "Rahim Motors axio r samner brake pad ferot dise",
      customer: "Rahim Motors",
      part: { part_type: "brake pad", vehicle: "axio", position: "samner" },
      one: "ek set",
      answers: ["2014", "non genuine", "dui set", "ha"],
    },
  ])(
    "D169: a sale of two sets, then both come back, refunded off the due ($style)",
    async ({ sale, saleArgs, back, again, customer, part, one, answers }) => {
      const [year, quality, two, yes] = answers as [string, string, string, string];
      const tap = (reply: Awaited<ReturnType<typeof say>>, label: RegExp) => {
        const choices = reply.events.find((event) => event.type === "choices");
        const option =
          choices?.type === "choices" ? choices.options.find((o) => label.test(o.label)) : undefined;
        if (choices?.type !== "choices" || !option) throw new Error(`no ${label}: ${reply.reply}`);
        return { choice: { slot: choices.slot, optionId: option.id } };
      };
      /** Answers the part's questions, and picks today's sale when several are found. */
      const toSheet = async (first: Awaited<ReturnType<typeof say>>) => {
        let reply = await say((await say(first.state, year)).state, quality);
        if (reply.reply.endsWith("কোন দিনের বিক্রি?")) reply = await say(reply.state, tap(reply, /^আজ, /));
        return reply;
      };
      const due = await balance("customers", "Rahim Motors");

      // The sale, as A.6 makes it.
      const first = await say(fresh(), sale, [
        scripted([{ calls: [{ name: "record_sale", arguments: saleArgs }] }]),
      ]);
      const quantity = await say((await say((await say(first.state, year)).state, quality)).state, two);
      const partId = quantity.outcome.actions[0]!.preview!.lines[0]!.hostPartId;
      const sold = await say(quantity.state, yes);
      expect(sold.outcome.actions[0]).toMatchObject({ status: "done" });
      expect(await balance("customers", "Rahim Motors")).toBe(due + 3200n);
      const stock = await stockOf(partId);

      // The first set back: today's sale, one set, off the due.
      calls.length = 0;
      const start = await say(fresh(), back, [
        scripted([
          { calls: [{ name: "record_return", arguments: { customer, items: [{ part, quantity: one }] } }] },
        ]),
      ]);
      const sheet = await toSheet(start);
      expect(sheet.reply).toBe(
        "Rahim Motors — আজকের এক্সিও ২০১৪, সামনের ব্রেক প্যাড, নন-জেনুইন, ১ সেট, ১,৬০০ টাকা ফেরত, বাকি থেকে কাটা হবে। ঠিক আছে?",
      );
      expect(nothingSent()).toBe(true);
      const backed = await say(sheet.state, yes);
      expect(backed.reply).toBe(`হয়ে গেছে। Rahim Motors-এর মোট বাকি এখন ${formatTaka(due + 1600n)} টাকা।`);
      expect(backed.outcome.actions[0]).toMatchObject({ status: "done", verifyStatus: "ok" });
      expect(backed.events.find((event) => event.type === "action_result")).toMatchObject({
        status: "done",
        undo_available: false,
      });
      expect(await stockOf(partId)).toBe(stock + 1);

      // The second set: the line's last, so no quantity is asked.
      const next = await say(fresh(), again, [
        scripted([{ calls: [{ name: "record_return", arguments: { customer, items: [{ part }] } }] }]),
      ]);
      const last = await toSheet(next);
      expect(last.reply).toMatch(
        /^Rahim Motors — আজকের .*, ১ সেট, ১,৬০০ টাকা ফেরত, বাকি থেকে কাটা হবে। ঠিক আছে\?$/,
      );
      const done = await say(last.state, yes);
      expect(done.outcome.actions[0]).toMatchObject({ status: "done", verifyStatus: "ok" });
      // Both back: the seed's due and stock are as they were before the sale.
      expect(await balance("customers", "Rahim Motors")).toBe(due);
      expect(await stockOf(partId)).toBe(stock + 2);
      saved.clear(); // the sale has its returns now, so it is never voided (D29)
    },
  );

  it.each([
    {
      style: "Bangla",
      text: "রহিম মোটরসকে এক্সিওর সামনের ব্রেক প্যাড বাকিতে দাও",
      args: {
        customer: "রহিম মোটরস",
        items: [{ part: { part_type: "সামনের ব্রেক প্যাড", vehicle: "এক্সিও", position: "সামনের" } }],
        payment: { method_word: "বাকিতে" },
      },
      answers: ["২০১৪", "নন-জেনুইন"],
      // As the server got them on 9 Oct: "দুই সেক্টর", which sounds like the app's Bajaj Discover 125, second among the
      // speech service's guesses, then first, with "দুই সেট" chosen as the transcript.
      quantities: [
        { text: "দুই সেট", nbest: ["দুই সেট", "দুই সেক্টর", "দুই সেন্ট", "দুই সেক্ট", "দুই সেক"] },
        { text: "দুই সেট", nbest: ["দুই সেক্টর", "দুই সেট", "দুই সেন্ট", "দুই সেক্ট", "ধুই সেক্টর"] },
      ],
    },
    {
      style: "Banglish",
      text: "Rahim Motors ke axior samner brake pad bakite dao",
      args: {
        customer: "Rahim Motors",
        items: [{ part: { part_type: "brake pad", vehicle: "axio", position: "samner" } }],
        payment: { method_word: "bakite" },
      },
      answers: ["2014", "non genuine"],
      quantities: [
        { text: "dui set", nbest: ["dui set", "dui discover", "dui sector"] },
        { text: "dui set", nbest: ["dui discover", "dui set", "dui sector"] },
      ],
    },
  ])(
    "a quantity said by voice stays the answer though another guess sounds like a car (D147; $style)",
    async ({ text, args, answers, quantities }) => {
      calls.length = 0;
      // The app's own car names are words too, as the server builds them (D122).
      const shopDictionary = buildDictionary([...GLOSSARY, ...catalogEntries(catalog)]);
      const voice = async (
        state: TurnState,
        said: { text: string; nbest: string[] },
        llm: LlmProvider[] = [scripted([])],
      ) => {
        const events: ReplyEvent[] = [];
        const outcome = await runTurn(
          { text: said.text, hypotheses: said.nbest },
          state,
          { ...deps(llm), dictionary: shopDictionary },
          (event) => events.push(event),
        );
        const reply = events
          .filter((event) => event.type === "text")
          .map((event) => (event as { text: string }).text)
          .join(" ");
        return { reply, outcome, state: outcome.state };
      };
      const heard = (said: string) => ({ text: said, nbest: [said] });
      for (const quantity of quantities) {
        const first = await voice(fresh(), heard(text), [
          scripted([{ calls: [{ name: "record_sale", arguments: args }] }]),
        ]);
        const year = await voice(first.state, heard(answers[0]!));
        const quality = await voice(year.state, heard(answers[1]!));
        expect(quality.reply).toBe("কয় সেট?");
        const said = await voice(quality.state, quantity);
        expect(said.reply).toBe(
          "Rahim Motors — এক্সিও ২০১৪, সামনের ব্রেক প্যাড, নন-জেনুইন, ২ সেট, ৩,২০০ টাকা, বাকিতে। ঠিক আছে?",
        );
        expect(said.outcome.actions).toEqual([expect.objectContaining({ status: "pending" })]);
      }
      expect(nothingSent()).toBe(true);
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
      // Both begin with the name said, so they are equal and come in either order.
      expect(["Rahim Motors নাকি Rahim Auto Garage?", "Rahim Auto Garage নাকি Rahim Motors?"]).toContain(
        first.reply,
      );
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
      text: "নবাবপুর অটো পার্টস থেকে এক্সিও ২০১৪ সামনের নন জেনুইন ব্রেক প্যাড পাঁচ সেন্ট কিনলাম",
      quantity: "পাঁচ",
    },
    {
      style: "Banglish",
      text: "Nawabpur Auto Parts theke axio 2014 samner non genuine brake pad 5 cent kinlam",
      quantity: "5",
    },
  ])(
    "never takes a quantity for the unit cost: সেট heard as সেন্ট asks the price (D157; $style)",
    async ({ text, quantity }) => {
      calls.length = 0;
      // The model reads "পাঁচ সেন্ট" as five sets at five taka.
      const llm = scripted([
        {
          calls: [
            {
              name: "stock_in",
              arguments: {
                supplier: "Nawabpur Auto Parts Ltd.",
                items: [
                  {
                    part: {
                      part_type: "ব্রেক প্যাড",
                      vehicle: "এক্সিও",
                      year: "২০১৪",
                      position: "সামনের",
                      quality: "নন-জেনুইন",
                    },
                    quantity,
                    unit_cost: quantity,
                  },
                ],
              },
            },
          ],
        },
      ]);
      const first = await say(fresh(), text, [llm]);
      expect(first.reply).toBe(
        "Nawabpur Auto Parts Ltd., এক্সিওর সামনের ব্রেক প্যাড — প্রতি সেট কেনা দাম কত?",
      );
      expect(nothingSent()).toBe(true);
    },
  );

  it.each([
    {
      style: "Bangla",
      text: "নওয়াপুর অটোপাস থেকে এক্সিও ২০১৪ সামনের নন-জেনুইন ব্রেক প্যাড ৫ সেট কিনলাম, প্রতি সেট ১২০০ টাকা, বাকিতে",
      heard: "নওয়াপুর অটোপাস",
      meant: "নবাবপুর অটো পার্টস",
    },
    {
      style: "Banglish",
      text: "Nowapur Autopas theke axio 2014 samner non genuine brake pad 5 set kinlam, proti set 1200 taka, bakite",
      heard: "nowapur autopas",
      meant: "Nawabpur Auto Parts",
    },
  ])(
    "a misheard supplier the LLM chose among the shop's names is read back in bold (D153; $style)",
    async ({ text, heard, meant }) => {
      calls.length = 0;
      const supplier = "Nawabpur Auto Parts Ltd.";
      const llm = scripted(
        [
          {
            calls: [
              {
                name: "stock_in",
                arguments: {
                  supplier,
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
              },
            ],
          },
        ],
        [JSON.stringify({ replaced: [{ heard, meant }] })],
      );
      const first = await say(fresh(), text, [llm]);
      expect(first.outcome.trace.cleanup).toEqual([{ heard, meant: supplier }]);
      expect(first.reply).toBe(
        `${supplier} থেকে ব্রেক প্যাড, ৫ সেট, প্রতি সেট ১,২০০ টাকা, মোট ৬,০০০ টাকা। ঠিক আছে?`,
      );
      expect(first.events.find((event) => event.type === "confirm")).toMatchObject({
        fields: expect.arrayContaining([{ label: "সাপ্লায়ার", value: supplier, highlight: true }]),
      });
      expect(nothingSent()).toBe(true);
    },
  );

  it.each([
    {
      style: "Bangla",
      text: "নওয়াপুর অটোপাস থেকে এক্সিও ২০১৪ সামনের নন-জেনুইন ব্রেক প্যাড ৫ সেট কিনলাম, প্রতি সেট ১২০০ টাকা, বাকিতে",
      // The model left out the part type, year and quality, and kept the supplier as the speech service heard it.
      args: {
        supplier: "নওয়াপুর অটোপাস",
        items: [{ part: { vehicle: "এক্সিও", position: "সামনের" }, quantity: "৫ সেট", unit_cost: "১২০০" }],
        payment: { method_word: "বাকিতে" },
      },
    },
    {
      style: "Banglish",
      text: "Nowapur Autopas theke axio 2014 samner non genuine brake pad 5 set kinlam, proti set 1200 taka, bakite",
      args: {
        supplier: "Nowapur Autopas",
        items: [{ part: { vehicle: "axio", position: "samner" }, quantity: "5 set", unit_cost: "1200" }],
        payment: { method_word: "bakite" },
      },
    },
  ])(
    "a stock-in the model left half-filled: the request's words fill the part, a misheard supplier is a button (D148; $style)",
    async ({ text, args }) => {
      calls.length = 0;
      const first = await say(fresh(), text, [
        scripted([{ calls: [{ name: "stock_in", arguments: args }] }]),
      ]);
      expect(first.reply).toMatch(/কার কাছ থেকে\?$/);
      const choices = first.events.find((event) => event.type === "choices");
      expect(choices).toMatchObject({ slot: "supplier" });
      const options = (choices as Extract<ReplyEvent, { type: "choices" }>).options;
      expect(options[0]?.label).toBe("Nawabpur Auto Parts Ltd.");
      const picked = await say(first.state, { choice: { slot: "supplier", optionId: options[0]!.id } });
      expect(picked.reply).toBe(
        "Nawabpur Auto Parts Ltd. থেকে ব্রেক প্যাড, ৫ সেট, প্রতি সেট ১,২০০ টাকা, মোট ৬,০০০ টাকা। ঠিক আছে?",
      );
      // How the name was heard may be learned (D155).
      expect(picked.outcome.learned).toEqual([
        {
          heard: normalize(args.supplier).tokens.join(" "),
          concept: "supplier",
          value: "Nawabpur Auto Parts Ltd.",
        },
      ]);
      expect(picked.outcome.actions).toEqual([expect.objectContaining({ status: "pending" })]);
      expect(nothingSent()).toBe(true);
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

  it.each([
    {
      style: "Bangla",
      text: "রহিম মোটরসকে এক্সিওর সামনের ব্রেক প্যাড বাকিতে দাও",
      search: { part_type: "Brake Pad", vehicle: "Axio", position: "front" },
      answers: ["২০১৪", "নন-জেনুইন", "দুই সেট", "না"],
    },
    {
      style: "Banglish",
      text: "Rahim Motors ke axior samner brake pad bakite dao",
      search: { part_type: "brake pad", vehicle: "axio", position: "samner" },
      answers: ["2014", "non genuine", "dui set", "na"],
    },
  ])(
    "starts the sale a sentence asks for even when the model searches first, as the laptop's model does (D140; $style)",
    async ({ text, search, answers }) => {
      calls.length = 0;
      const first = await say(fresh(), text, [
        scripted([{ calls: [{ name: "find_parts", arguments: search }] }]),
      ]);
      expect(first.reply).toMatch(/এক্সিওর সামনের ব্রেক প্যাড — কোন বছরের এক্সিও\?$/);
      const quality = await say(first.state, answers[0]!);
      expect(quality.reply).toBe("জেনুইন না নন-জেনুইন?");
      const quantity = await say(quality.state, answers[1]!);
      expect(quantity.reply).toBe("কয় সেট?");
      const confirm = await say(quantity.state, answers[2]!);
      expect(confirm.reply).toBe(
        "Rahim Motors — এক্সিও ২০১৪, সামনের ব্রেক প্যাড, নন-জেনুইন, ২ সেট, ৩,২০০ টাকা, বাকিতে। ঠিক আছে?",
      );
      expect((await say(confirm.state, answers[3]!)).reply).toBe("বাতিল করা হয়েছে, কিছু সেভ হয়নি।");
      expect(nothingSent()).toBe(true);
    },
  );

  it.each([
    { style: "Bangla", text: "রহিম মোটরসকে এক্সিও ২০১৪ সামনের নন-জেনুইন ব্রেক প্যাড বাকিতে দাও" },
    { style: "Banglish", text: "Rahim Motors ke axio 2014 samner non genuine brake pad bakite dao" },
  ])(
    "asks a quantity the user did not say, even when the model fills one in (D140; $style)",
    async ({ text }) => {
      const args = {
        customer: "Rahim Motors",
        items: [
          {
            part: {
              part_type: "brake pad",
              vehicle: "axio",
              year: "2014",
              position: "front",
              quality: "non genuine",
            },
            quantity: "1 set",
          },
        ],
        payment: { method_word: "bakite" },
      };
      const first = await say(fresh(), text, [
        scripted([{ calls: [{ name: "record_sale", arguments: args }] }]),
      ]);
      expect(first.reply).toMatch(/কয় সেট\?$/);
      expect(first.outcome.actions).toEqual([]);
    },
  );

  // D173, a new customer inside a sale on the test host: the new-name button adds it (its own dry run, then yes), and
  // the sale goes on with it to its own dry run. The sale is then cancelled and the add undone, so the seed ends as it
  // began. GearGrid's own tests show a customer that has bought is never removed (CUSTOMER_IN_USE).
  it.each([
    {
      style: "Bangla",
      text: "সেলিম অটোকে এক্সিও ২০১৪-এর সামনের নন-জেনুইন ব্রেক প্যাড দুই সেট বাকিতে দাও",
      args: {
        customer: "সেলিম অটো",
        items: [
          {
            part: {
              part_type: "সামনের ব্রেক প্যাড",
              vehicle: "এক্সিও",
              year: "২০১৪",
              position: "সামনের",
              quality: "নন-জেনুইন",
            },
            quantity: "দুই সেট",
          },
        ],
        payment: { method_word: "বাকিতে" },
      },
      name: "সেলিম অটো",
      phone: "০১৮১১-২২৩৩৪৪",
      yes: "হ্যাঁ",
      no: "না",
    },
    {
      style: "Banglish",
      text: "Selim Auto ke axio 2014 er samner non genuine brake pad dui set bakite dao",
      args: {
        customer: "Selim Auto",
        items: [
          {
            part: {
              part_type: "brake pad",
              vehicle: "axio",
              year: "2014",
              position: "samner",
              quality: "non genuine",
            },
            quantity: "dui set",
          },
        ],
        payment: { method_word: "bakite" },
      },
      name: "Selim Auto",
      phone: "01811 223344",
      yes: "ha",
      no: "na",
    },
  ])("D173: a sale adds its new customer and goes on with it; the add is undone ($style)", async (said) => {
    calls.length = 0;
    const tap = (reply: Awaited<ReturnType<typeof say>>, label: RegExp) => {
      const choices = reply.events.find((event) => event.type === "choices");
      const option =
        choices?.type === "choices" ? choices.options.find((o) => label.test(o.label)) : undefined;
      if (choices?.type !== "choices" || !option) throw new Error(`no ${label}: ${reply.reply}`);
      return { choice: { slot: choices.slot, optionId: option.id } };
    };
    const customers = async () => {
      const [row] = await pools.readOnly(db, (run) =>
        run({ text: "select count(*)::text as n from customers where deleted_at is null", values: [] }),
      );
      return Number(row!.n);
    };
    const before = await customers();
    const asked = await say(fresh(), said.text, [
      scripted([{ calls: [{ name: "record_sale", arguments: said.args }] }]),
    ]);
    expect(asked.reply).toMatch(/কার নামে\?$/);
    const typed = await say(asked.state, tap(asked, /^নতুন হিসেবে যোগ করুন$/));
    expect(typed.reply).toBe("খুচরা না পাইকারি?");
    const phone = await say(typed.state, tap(typed, /^পাইকারি$/));
    const sheet = await say(phone.state, said.phone);
    expect(sheet.reply).toBe(`নতুন কাস্টমার: ${said.name}, পাইকারি, ০১৮১১-২২৩৩৪৪। যোগ করব?`);
    expect(nothingSent()).toBe(true);
    expect(await customers()).toBe(before);

    const added = await say(sheet.state, said.yes);
    expect(added.reply).toMatch(
      new RegExp(
        `^${said.name} যোগ হয়েছে। ${said.name} — এক্সিও ২০১৪, সামনের ব্রেক প্যাড, নন-জেনুইন, ২ সেট, .*বাকিতে। ঠিক আছে\\?$`,
      ),
    );
    const record = added.outcome.added[0]!;
    expect(record).toMatchObject({ concept: "customer", name: said.name });
    const addAction = added.outcome.actions.find((action) => action.status === "done")!;
    expect(addAction).toMatchObject({ verifyStatus: "ok" });
    const [row] = await pools.readOnly(db, (run) =>
      run({ text: "select type, price_tier, phone from customers where id = $1", values: [record.hostId] }),
    );
    expect(row).toEqual({ type: "garage", price_tier: "garage", phone: "01811223344" });
    expect(calls.at(-1)).toMatchObject({ path: "/api/v1/sales", query: { dry_run: "true" } });
    expect(calls.at(-1)!.body).toMatchObject({ customer_id: record.hostId });

    const cancelled = await say(added.state, said.no);
    expect(cancelled.reply).toBe("বাতিল করা হয়েছে, কিছু সেভ হয়নি।");
    const undone = await undo(addAction, { preview: sheet.outcome.actions[0]!.preview! });
    expect(undone).toMatchObject({ status: "undone" });
    expect(await customers()).toBe(before);
    catalog.customers = catalog.customers.filter((customer) => customer.hostId !== record.hostId);
  });

  it.each([
    {
      style: "Bangla",
      text: "নতুন সাপ্লায়ার যোগ করো, ঢাকা অটো ট্রেডার্স",
      name: "ঢাকা অটো ট্রেডার্স",
      none: "নেই",
      yes: "হ্যাঁ",
    },
    {
      style: "Banglish",
      text: "notun supplier add koro, Dhaka Auto Traders",
      name: "Dhaka Auto Traders",
      none: "nei",
      yes: "ha",
    },
  ])("D173: a new supplier is added, read back and undone ($style)", async (said) => {
    calls.length = 0;
    const first = await say(fresh(), said.text, [
      scripted([{ calls: [{ name: "add_supplier", arguments: { name: said.name } }] }]),
    ]);
    expect(first.reply).toBe("ফোন নম্বর কত? না থাকলে “নেই” বলুন।");
    const sheet = await say(first.state, said.none);
    expect(sheet.reply).toBe(`নতুন সাপ্লায়ার: ${said.name}। যোগ করব?`);
    expect(nothingSent()).toBe(true);
    const done = await say(sheet.state, said.yes);
    expect(done.reply).toBe(`${said.name} যোগ হয়েছে।`);
    const action = done.outcome.actions[0]!;
    expect(action).toMatchObject({ status: "done", verifyStatus: "ok" });
    const record = done.outcome.added[0]!;
    expect(record).toMatchObject({ concept: "supplier", name: said.name });
    const undone = await undo(action, { preview: sheet.outcome.actions[0]!.preview! });
    expect(undone).toMatchObject({ status: "undone" });
    const [row] = await pools.readOnly(db, (run) =>
      run({
        text: "select deleted_at is not null as gone from suppliers where id = $1",
        values: [record.hostId],
      }),
    );
    expect(row).toEqual({ gone: true });
    catalog.suppliers = catalog.suppliers.filter((supplier) => supplier.hostId !== record.hostId);
  });
});
