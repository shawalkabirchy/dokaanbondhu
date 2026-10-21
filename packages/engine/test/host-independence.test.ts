import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { callHost, fetchOpenApi } from "../src/host/api";
import { importOpenApi } from "../src/host/openapi-import";
import { writeHostOf } from "../src/write/sandbox";
import { connect, fresh, geargrid, NOW, type Shop } from "./sale-apps";
import type { Step } from "./scripted-llm";
import { startStubHost, STUB_PROFIT, STUB_TOTAL, type StubFeatures, type StubState } from "./stub-host";

// Host independence (spec 18.1, the architecture's host features; D180, D181): every optional feature of a shop app
// used when present and its fallback run when absent, against the stub host over HTTP, its document imported as setup
// does. In Bangla and in Banglish (D96).

const hosts: Awaited<ReturnType<typeof startStubHost>>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

/** The stub host with these features, connected as setup leaves it: every write switched on. */
async function stubShop(features: StubFeatures, state: StubState = {}, appFields: Partial<Shop> = {}) {
  const stub = await startStubHost(features, state);
  hosts.push(stub);
  const { document, path } = await fetchOpenApi(stub.connection);
  const imported = importOpenApi(document, path);
  stub.connection.features = imported.features;
  const writes = writeHostOf(imported, (request) => callHost(stub.connection, request), randomUUID);
  // The app's stock moves with its orders, so the check after a sale finds what it expects.
  const app = { ...geargrid, ...appFields, stock: {} as Record<string, number> };
  stub.state.onOrder = (body) => {
    for (const line of (body as { lines: { partId: string; qty: number }[] }).lines)
      app.stock[line.partId] = (app.stock[line.partId] ?? 4) - line.qty;
  };
  const shop = connect(app, { writes, role: "owner", actingUser: "Test Staff" });
  /** The calls to the app other than its document, by path. */
  const calls = (path: string) => stub.requests.filter((request) => request.path === path);
  return { stub, shop, calls, imported };
}

const STYLES = [
  {
    style: "Bangla",
    sale: "রহিম মোটরসকে ফিল্ডার ২০১৫-এর ব্রেক প্যাড দুই সেট বাকিতে দাও",
    args: {
      customer: "রহিম মোটরস",
      items: [{ part: { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার", year: "২০১৫" }, quantity: "দুই সেট" }],
      payment: { method_word: "বাকিতে" },
    },
    yes: "হ্যাঁ",
    ask: "ফিল্ডার ২০১৫-এর ব্রেক প্যাড আছে?",
    part: { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার", year: "২০১৫" },
    profit: "আজ কত লাভ হলো?",
  },
  {
    style: "Banglish",
    sale: "Rahim Motors ke fielder 2015 er brake pad dui set bakite dao",
    args: {
      customer: "Rahim Motors",
      items: [{ part: { part_type: "brake pad", vehicle: "fielder", year: "2015" }, quantity: "dui set" }],
      payment: { method_word: "bakite" },
    },
    yes: "ha",
    ask: "fielder 2015 er brake pad ache?",
    part: { part_type: "brake pad", vehicle: "fielder", year: "2015" },
    profit: "aj koto lav holo?",
  },
] as const;

const saleCall = (args: object): Step[] => [{ calls: [{ name: "create_order", arguments: { ...args } }] }];

describe("a sale on an app named unlike GearGrid (D181)", () => {
  it.each(STYLES)(
    "setup reads its document: an order is a sale, with the feature list it names ($style)",
    async () => {
      const { imported } = await stubShop({
        dryRun: true,
        idempotency: true,
        undo: true,
        banglaErrors: true,
      });
      expect(imported.capabilities.find((item) => item.name === "create_order")).toMatchObject({
        template: "sale",
        supportsDryRun: true,
        compensation: { operation: "cancel_order" },
      });
      expect(imported.features).toMatchObject({
        dry_run: "?preview=1",
        idempotency_header: "X-Request-Key",
        bangla_errors: "error.text_bn",
      });
    },
  );

  it.each(STYLES)(
    "dry run: the app's own total; without one, the total from the prices ($style)",
    async (said) => {
      const withDry = await stubShop({ dryRun: true });
      const sheet = await withDry.shop.say(fresh(), { text: said.sale }, saleCall(said.args));
      // An app without payment methods takes none, so the sentence names none (D181).
      expect(STUB_TOTAL).toBe(2900);
      expect(sheet.confirm?.text).toMatch(/২ সেট, ২,৯০০ টাকা। ঠিক আছে\?$/);
      expect(withDry.calls("/orders")).toEqual([expect.objectContaining({ query: { preview: "1" } })]);

      const without = await stubShop({});
      const estimate = await without.shop.say(fresh(), { text: said.sale }, saleCall(said.args));
      expect(estimate.confirm?.text).toMatch(/২ সেট, ৩,২০০ টাকা। ঠিক আছে\?$/);
      expect(without.calls("/orders")).toEqual([]); // nothing is sent before yes
    },
  );

  it.each(STYLES)(
    "without a dry run, a customer named in the sentence is billed at their own price level ($style)",
    async (said) => {
      // Rahim Motors buys at the garage price (1,500 a set, the paikari price), not the 1,600 retail (D183).
      const garage = await stubShop({}, {}, { customerAttrs: { price_tier: "garage" } });
      const sheet = await garage.shop.say(fresh(), { text: said.sale }, saleCall(said.args));
      expect(sheet.confirm?.text).toMatch(/২ সেট, ৩,০০০ টাকা। ঠিক আছে\?$/);
      // With a dry run the app's own total stands, whatever the level.
      const dry = await stubShop({ dryRun: true }, {}, { customerAttrs: { price_tier: "garage" } });
      const dryRun = await dry.shop.say(fresh(), { text: said.sale }, saleCall(said.args));
      expect(dryRun.confirm?.text).toMatch(/২ সেট, ২,৯০০ টাকা। ঠিক আছে\?$/);
    },
  );

  it.each(STYLES)(
    "idempotency key and acting user: sent when named, left out when not ($style)",
    async (said) => {
      const named = await stubShop({ idempotency: true, actingUser: true });
      const sheet = await named.shop.say(fresh(), { text: said.sale }, saleCall(said.args));
      const done = await named.shop.say(sheet.state, { text: said.yes });
      expect(done.results).toEqual(["done"]);
      const saved = named.calls("/orders").at(-1)!;
      // The action's own key, so a retry of it is the same request to the app.
      expect(saved.headers["x-request-key"]).toBe(sheet.state.action?.idempotencyKey);
      expect(saved.headers["x-done-by"]).toBe("Test Staff");

      const bare = await stubShop({});
      const plain = await bare.shop.say(fresh(), { text: said.sale }, saleCall(said.args));
      const saved2 = await bare.shop.say(plain.state, { text: said.yes });
      expect(saved2.results).toEqual(["done"]);
      const request = bare.calls("/orders").at(-1)!;
      expect(request.headers["x-request-key"]).toBeUndefined();
      expect(request.headers["x-done-by"]).toBeUndefined();
      expect(bare.calls("/orders")).toHaveLength(1); // no blind retry
    },
  );

  it.each(STYLES)(
    "undo: offered when the app has one, not offered when it has none ($style)",
    async (said) => {
      const withUndo = await stubShop({ undo: true });
      const sheet = await withUndo.shop.say(fresh(), { text: said.sale }, saleCall(said.args));
      expect((await withUndo.shop.say(sheet.state, { text: said.yes })).undoable).toEqual([true]);

      const without = await stubShop({});
      const plain = await without.shop.say(fresh(), { text: said.sale }, saleCall(said.args));
      expect((await without.shop.say(plain.state, { text: said.yes })).undoable).toEqual([false]);
    },
  );

  it.each(STYLES)(
    "a refusal: the app's Bangla text, else the template for its status ($style)",
    async (said) => {
      const bangla = await stubShop({ dryRun: true, banglaErrors: true }, { refuse: true });
      const reply = await bangla.shop.say(fresh(), { text: said.sale }, saleCall(said.args));
      expect(reply.reply).toBe("কাজটা হয়নি। স্টকে নেই।");

      const plain = await stubShop({ dryRun: true }, { refuse: true });
      const template = await plain.shop.say(fresh(), { text: said.sale }, saleCall(said.args));
      expect(template.reply).toBe("কাজটা হয়নি। অ্যাপ তথ্যগুলো নেয়নি।");
    },
  );

  it.each(STYLES)("an app with no payment methods: no payment question, none sent ($style)", async (said) => {
    const { shop, calls } = await stubShop({ dryRun: true });
    const sheet = await shop.say(fresh(), { text: said.sale }, saleCall(said.args));
    expect(sheet.asked).toBeUndefined();
    expect(calls("/orders").at(-1)!.body).not.toHaveProperty("payments");
  });
});

describe("a sale on an app that signs in with a session (D183)", () => {
  const signedSale = async (said: (typeof STYLES)[number]) => {
    const app = await stubShop({ session: true, dryRun: true });
    let saved = 0;
    const record = app.stub.state.onOrder!;
    app.stub.state.onOrder = (body) => {
      saved += 1;
      record(body);
    };
    const sheet = await app.shop.say(fresh(), { text: said.sale }, saleCall(said.args));
    expect(sheet.confirm?.text).toMatch(/২ সেট, ২,৯০০ টাকা। ঠিক আছে\?$/);
    return { ...app, sheet, saved: () => saved };
  };

  it.each(STYLES)(
    "signs in once, then sends its cookie and CSRF token; the password goes only to the login ($style)",
    async (said) => {
      const { shop, sheet, calls, stub, saved } = await signedSale(said);
      expect((await shop.say(sheet.state, { text: said.yes })).results).toEqual(["done"]);
      expect(saved()).toBe(1);
      expect(calls("/csrf-cookie")).toHaveLength(1);
      expect(calls("/login")).toEqual([
        expect.objectContaining({ body: { email: "owner@stub.test", password: stub.connection.secret } }),
      ]);
      const order = calls("/orders").at(-1)!;
      expect(order.headers.cookie).toMatch(/stub_session=sess\d+/);
      expect(order.headers["x-xsrf-token"]).toMatch(/^csrf\/\d+=$/); // the cookie's value, URL-decoded
      const others = stub.requests.filter((request) => request.path !== "/login");
      expect(JSON.stringify(others)).not.toContain(stub.connection.secret);
    },
  );

  it.each(STYLES)(
    "a session the app forgot (401) or a stale CSRF token (419): signs in again once, the sale saved once ($style)",
    async (said) => {
      for (const lose of ["forgetSessions", "staleTokens"] as const) {
        const { shop, sheet, calls, stub, saved } = await signedSale(said);
        stub[lose]();
        expect((await shop.say(sheet.state, { text: said.yes })).results, lose).toEqual(["done"]);
        expect(calls("/login"), lose).toHaveLength(2);
        expect(saved(), lose).toBe(1);
      }
    },
  );
});

describe("an app's own reports and sync status (D180, D181)", () => {
  const profitCall: Step[] = [
    { calls: [{ name: "get_report", arguments: { name: "profit_loss" } }] },
    { text: "" },
  ];

  it.each(STYLES)(
    "its own profit figure when it has one; else “see this in your app” ($style)",
    async (said) => {
      const withReports = await stubShop({ reports: true });
      const reply = await withReports.shop.say(fresh(), { text: said.profit }, profitCall);
      expect(reply.reply).toBe(`লাভ ${STUB_PROFIT === 45000 ? "৪৫,০০০" : ""} টাকা।`);
      expect(withReports.calls("/reports/profit_loss")).toHaveLength(1);

      const without = await stubShop({});
      expect((await without.shop.say(fresh(), { text: said.profit }, profitCall)).reply).toBe(
        "এটা আপনার অ্যাপে দেখুন।",
      );
    },
  );

  it.each(STYLES)("a report endpoint that fails falls back ($style)", async (said) => {
    const broken = await stubShop({ reports: true }, { brokenReports: true });
    expect((await broken.shop.say(fresh(), { text: said.profit }, profitCall)).reply).toBe(
      "এটা আপনার অ্যাপে দেখুন।",
    );
  });

  const partsCall = (said: (typeof STYLES)[number]): Step[] => [
    { calls: [{ name: "find_parts", arguments: { ...said.part } }] },
    { text: "" },
  ];

  it.each(STYLES)(
    "a read answer says how old the app's figures are after 30 minutes ($style)",
    async (said) => {
      const old = await stubShop({ syncStatus: true }, { lastSync: new Date(NOW.getTime() - 40 * 60_000) });
      const reply = await old.shop.say(fresh(), { text: said.ask }, partsCall(said));
      expect(reply.reply).toMatch(/অ্যাপের হিসাব শেষ মেলানো হয়েছে ৪০ মিনিট আগে।$/);

      const recent = await stubShop(
        { syncStatus: true },
        { lastSync: new Date(NOW.getTime() - 10 * 60_000) },
      );
      const fresh10 = await recent.shop.say(fresh(), { text: said.ask }, partsCall(said));
      expect(fresh10.reply).not.toMatch(/মেলানো হয়েছে/);
    },
  );

  it.each(STYLES)("an app without sync status: nothing said, nothing asked ($style)", async (said) => {
    const { shop, calls } = await stubShop({});
    const reply = await shop.say(fresh(), { text: said.ask }, partsCall(said));
    expect(reply.reply).not.toMatch(/মেলানো হয়েছে/);
    expect(calls("/sync/status")).toEqual([]);
  });
});
