import { describe, expect, it } from "vitest";
import {
  appCapability,
  connect,
  fresh,
  geargrid,
  ownWords,
  shopB,
  tap,
  type Reply,
  type Shop,
} from "../../test/sale-apps";
import type { Step } from "../../test/scripted-llm";
import { writeTool } from "../write/tool";

// D173: a new customer or supplier added by voice or chat (D165). The name as said; the close names and a record with
// the same phone shown first; a customer's type through the app's own words; the phone once, নেই taken; inside a sale
// or a stock-in, the new-name button adds it and the request goes on. In Bangla and in Banglish (D96), on the three app
// shapes of D167, each with its own customer types.

const call = (name: string, args: object): Step[] => [{ calls: [{ name, arguments: { ...args } }] }];
const lastBody = (shop: ReturnType<typeof connect>) => shop.calls.at(-1)?.body as Record<string, unknown>;

const SAID = [
  {
    style: "Bangla",
    add: "নতুন কাস্টমার যোগ করো, সেলিম অটো",
    name: "সেলিম অটো",
    phone: "০১৮১১-২২৩৩৪৪",
    none: "নেই",
    yes: "হ্যাঁ",
    no: "না",
    close: "রহিম মোটর",
    fix: "না, সেলিম অটোস",
    fixed: "সেলিম অটোস",
    supplier: "নতুন সাপ্লায়ার যোগ করো, ঢাকা অটো ট্রেডার্স",
    supplierName: "ঢাকা অটো ট্রেডার্স",
    retail: "নতুন খুচরা কাস্টমার যোগ করো, সেলিম অটো",
  },
  {
    style: "Banglish",
    add: "notun customer jog koro, Selim Auto",
    name: "Selim Auto",
    phone: "01811 223344",
    none: "nei",
    yes: "ha",
    no: "na",
    close: "Rahim Motor",
    fix: "na, Selim Autos",
    fixed: "Selim Autos",
    supplier: "notun supplier add koro, Dhaka Auto Traders",
    supplierName: "Dhaka Auto Traders",
    retail: "notun khuchra customer jog koro, Selim Auto",
  },
] as const;

/** Each app's own type value for a paikari customer and for a retail one. */
const TYPES: { app: Shop; paikari: string; retail: string }[] = [
  { app: geargrid, paikari: "garage", retail: "retail" },
  { app: shopB, paikari: "Mechanic", retail: "Walk-in" },
  { app: ownWords, paikari: "Dealer", retail: "Normal" },
];

for (const { app, paikari, retail } of TYPES) {
  describe(`${app.name}: a new customer (D173)`, () => {
    it.each(SAID)("is added with its type and phone, after a dry run ($style)", async (said) => {
      const shop = connect(app);
      const first = await shop.say(fresh(), { text: said.add }, call("add_customer", { name: said.name }));
      expect(first.reply).toBe("খুচরা না পাইকারি?");
      const typed = await shop.say(first.state, tap(first, /^পাইকারি$/));
      expect(typed.reply).toBe("ফোন নম্বর কত? না থাকলে “নেই” বলুন।");
      expect(typed.choices?.options.map((option) => option.label)).toEqual(["নেই"]);
      const sheet = await shop.say(typed.state, { text: said.phone });
      expect(sheet.confirm?.text).toBe(`নতুন কাস্টমার: ${said.name}, পাইকারি, ০১৮১১-২২৩৩৪৪। যোগ করব?`);
      expect(shop.calls).toHaveLength(1);
      expect(shop.calls[0]).toMatchObject({ path: "/api/v1/customers", query: { dry_run: "true" } });
      expect(lastBody(shop)).toEqual({ name: said.name, type: paikari, phone: "01811223344" });
      const done = await shop.say(sheet.state, { text: said.yes });
      expect(done.reply).toBe(`${said.name} যোগ হয়েছে।`);
      expect(done.results).toEqual(["done"]);
      expect(done.added).toEqual([
        {
          concept: "customer",
          hostId: "customer-new",
          name: said.name,
          attrs: { type: paikari, phone: "01811223344" },
        },
      ]);
    });

    it.each(SAID)("takes the type the request says, and নেই for the phone ($style)", async (said) => {
      const shop = connect(app);
      const first = await shop.say(fresh(), { text: said.retail }, call("add_customer", { name: said.name }));
      expect(first.reply).toBe("ফোন নম্বর কত? না থাকলে “নেই” বলুন।");
      const sheet = await shop.say(first.state, { text: said.none });
      expect(sheet.confirm?.text).toBe(`নতুন কাস্টমার: ${said.name}, খুচরা। যোগ করব?`);
      expect(lastBody(shop)).toEqual({ name: said.name, type: retail });
    });

    // D211: the type said aloud, spelled as speech-to-text wrote it on the owner's phone on 31 Oct, or close to it.
    it.each([
      { style: "Bangla", spoken: "পাইকারী", kind: "পাইকারি", value: paikari },
      { style: "Bangla", spoken: "পাইকার ই", kind: "পাইকারি", value: paikari },
      { style: "Bangla", spoken: "খুশরা", kind: "খুচরা", value: retail },
      { style: "Bangla", spoken: "কুচরা", kind: "খুচরা", value: retail },
      { style: "Banglish", spoken: "pikari", kind: "পাইকারি", value: paikari },
      { style: "Banglish", spoken: "paikary", kind: "পাইকারি", value: paikari },
      { style: "Banglish", spoken: "khushra", kind: "খুচরা", value: retail },
      { style: "Banglish", spoken: "kuchra", kind: "খুচরা", value: retail },
    ])("reads the type by its sound: $spoken ($style)", async ({ spoken, kind, value }) => {
      const shop = connect(app);
      const said = SAID[0];
      const first = await shop.say(fresh(), { text: said.add }, call("add_customer", { name: said.name }));
      const typed = await shop.say(first.state, { text: spoken });
      expect(typed.reply).toBe("ফোন নম্বর কত? না থাকলে “নেই” বলুন।");
      const sheet = await shop.say(typed.state, { text: said.none });
      expect(sheet.confirm?.text).toBe(`নতুন কাস্টমার: ${said.name}, ${kind}। যোগ করব?`);
      expect(lastBody(shop)).toEqual({ name: said.name, type: value });
    });

    it.each([
      { style: "Bangla", heard: "ফাইনাল", guess: "পাইকারি" },
      { style: "Banglish", heard: "final", guess: "paikari" },
    ])("takes the type from another speech guess ($style)", async ({ heard, guess }) => {
      const shop = connect(app);
      const said = SAID[0];
      const first = await shop.say(fresh(), { text: said.add }, call("add_customer", { name: said.name }));
      const typed = await shop.say(first.state, { text: heard, hypotheses: [heard, guess] });
      expect(typed.reply).toBe("ফোন নম্বর কত? না থাকলে “নেই” বলুন।");
    });
  });
}

// D211: what the sound check must leave alone.
describe("a type that is not one (GearGrid, D211)", () => {
  it.each([
    { style: "Bangla", spoken: "জানি না" },
    { style: "Banglish", spoken: "jani na" },
    { style: "Bangla", spoken: "সেলিম অটো" },
    { style: "Banglish", spoken: "Selim Auto" },
  ])("is asked again, and says so: $spoken ($style)", async ({ spoken }) => {
    const shop = connect(geargrid);
    const said = SAID[0];
    const first = await shop.say(fresh(), { text: said.add }, call("add_customer", { name: said.name }));
    const again = await shop.say(first.state, { text: spoken });
    expect(again.reply).toBe("বুঝতে পারিনি। খুচরা না পাইকারি?");
    expect(again.choices?.options.map((option) => option.label)).toEqual(["খুচরা", "পাইকারি"]);
  });

  it.each([
    { style: "Bangla", spoken: "ডিলার" },
    { style: "Banglish", spoken: "dealer" },
    { style: "Bangla", spoken: "গ্যারেজ" },
    { style: "Banglish", spoken: "garage" },
  ])("the app's own words still read as paikari: $spoken ($style)", async ({ spoken }) => {
    const shop = connect(geargrid);
    const said = SAID[0];
    const first = await shop.say(fresh(), { text: said.add }, call("add_customer", { name: said.name }));
    const typed = await shop.say(first.state, { text: spoken });
    expect(typed.reply).toBe("ফোন নম্বর কত? না থাকলে “নেই” বলুন।");
  });

  it.each([
    { style: "Bangla", fix: "না, পাইকারী" },
    { style: "Banglish", fix: "na, pikari" },
  ])("a type corrected on the sheet is read by its sound too ($style)", async ({ fix }) => {
    const shop = connect(geargrid);
    const said = SAID[0];
    const first = await shop.say(fresh(), { text: said.retail }, call("add_customer", { name: said.name }));
    const sheet = await shop.say(first.state, { text: said.none });
    expect(sheet.confirm?.text).toBe(`নতুন কাস্টমার: ${said.name}, খুচরা। যোগ করব?`);
    const fixed = await shop.say(sheet.state, { text: fix });
    expect(fixed.confirm?.text).toBe(`নতুন কাস্টমার: ${said.name}, পাইকারি। যোগ করব?`);
  });
});

describe("what is shown before a new customer is added (GearGrid, D173)", () => {
  it.each(SAID)("a close name: tapping it adds nothing ($style)", async (said) => {
    const shop = connect(geargrid);
    const first = await shop.say(fresh(), { text: said.add }, call("add_customer", { name: said.close }));
    expect(first.reply).toBe("Rahim Motors আগে থেকে আছে। নতুন যোগ করব?");
    expect(first.choices?.options.map((option) => option.label)).toEqual([
      "Rahim Motors",
      "নতুন হিসেবে যোগ করুন",
    ]);
    const reply = await shop.say(first.state, tap(first, /^Rahim Motors$/));
    expect(reply.reply).toBe("Rahim Motors আগে থেকেই আছে।");
    expect(shop.calls).toHaveLength(0);
  });

  it.each(SAID)("a close name: the new-name button goes on with the new one ($style)", async (said) => {
    const shop = connect(geargrid);
    const first = await shop.say(fresh(), { text: said.add }, call("add_customer", { name: said.close }));
    const reply = await shop.say(first.state, tap(first, /^নতুন হিসেবে যোগ করুন$/));
    expect(reply.reply).toBe("খুচরা না পাইকারি?");
  });

  it.each(SAID)("a phone another customer has: that customer is shown first ($style)", async (said) => {
    const shop = connect(geargrid);
    const first = await shop.say(fresh(), { text: said.retail }, call("add_customer", { name: said.name }));
    const same = await shop.say(first.state, { text: "01711000000" });
    expect(same.reply).toBe("এই নম্বর Rahim Motors-এর। নতুন যোগ করব?");
    const sheet = await shop.say(same.state, tap(same, /^নতুন হিসেবে যোগ করুন$/));
    expect(sheet.confirm?.text).toBe(`নতুন কাস্টমার: ${said.name}, খুচরা, ০১৭১১-০০০০০০। যোগ করব?`);
  });

  it.each(SAID)("a name corrected on the sheet: “না, …” confirms the new one ($style)", async (said) => {
    const shop = connect(geargrid);
    const first = await shop.say(fresh(), { text: said.retail }, call("add_customer", { name: said.name }));
    const sheet = await shop.say(first.state, { text: said.none });
    const fixed = await shop.say(sheet.state, { text: said.fix });
    expect(fixed.confirm?.text).toBe(`নতুন কাস্টমার: ${said.fixed}, খুচরা। যোগ করব?`);
    expect(lastBody(shop)).toMatchObject({ name: said.fixed });
  });

  it.each(SAID)("a phone that is not one is asked again, and says so ($style)", async (said) => {
    const shop = connect(geargrid);
    const first = await shop.say(fresh(), { text: said.retail }, call("add_customer", { name: said.name }));
    const again = await shop.say(first.state, { text: "০১২৩৪" });
    expect(again.reply).toBe("নম্বরটা বুঝতে পারিনি। এক এক করে বলুন, বা লিখে দিন।");
    expect(again.choices?.options.map((option) => option.label)).toEqual(["নেই"]);
  });

  // D211: as speech-to-text wrote the digits on the owner's phone on 31 Oct. A number is never guessed.
  it.each([
    { style: "Bangla", spoken: "জিরো ওয়ান আট ওয়াউন ওয়াইন টু টু ত্রি থ্রাই ফোর ফোট" },
    { style: "Banglish", spoken: "ziro one at waun wine two two tri thrai four fot" },
  ])("garbled digits are asked again, not guessed ($style)", async ({ spoken }) => {
    const shop = connect(geargrid);
    const said = SAID[0];
    const first = await shop.say(fresh(), { text: said.retail }, call("add_customer", { name: said.name }));
    const again = await shop.say(first.state, { text: spoken });
    expect(again.reply).toBe("নম্বরটা বুঝতে পারিনি। এক এক করে বলুন, বা লিখে দিন।");
    expect(shop.calls).toHaveLength(0);
  });

  it.each(SAID)("a supplier: no type, the phone, its own sheet ($style)", async (said) => {
    const shop = connect(geargrid);
    const first = await shop.say(
      fresh(),
      { text: said.supplier },
      call("add_supplier", { name: said.supplierName }),
    );
    expect(first.reply).toBe("ফোন নম্বর কত? না থাকলে “নেই” বলুন।");
    const sheet = await shop.say(first.state, tap(first, /^নেই$/));
    expect(sheet.confirm?.text).toBe(`নতুন সাপ্লায়ার: ${said.supplierName}। যোগ করব?`);
    expect(shop.calls[0]).toMatchObject({ path: "/api/v1/suppliers", body: { name: said.supplierName } });
    const done = await shop.say(sheet.state, { text: said.yes });
    expect(done.reply).toBe(`${said.supplierName} যোগ হয়েছে।`);
    expect(done.added).toMatchObject([{ concept: "supplier", hostId: "supplier-new" }]);
  });
});

const SALE = [
  {
    style: "Bangla",
    text: "সেলিম অটোকে এক্সিও ২০১৪-এর জেনুইন ব্রেক প্যাড দুই সেট বাকিতে দাও",
    customer: "সেলিম অটো",
    part: { part_type: "ব্রেক প্যাড", vehicle: "এক্সিও", year: "২০১৪", quality: "জেনুইন" },
    quantity: "দুই সেট",
    method: "বাকিতে",
    buy: "সেলিম ট্রেডার্স থেকে এক্সিও ২০১৪-এর জেনুইন ব্রেক প্যাড দুই সেট বাকিতে কিনলাম, প্রতি সেট ১২০০ টাকা",
    supplier: "সেলিম ট্রেডার্স",
    cost: "১২০০ টাকা",
    yes: "হ্যাঁ",
    no: "না",
    none: "নেই",
  },
  {
    style: "Banglish",
    text: "Selim Auto ke axio 2014 er genuine brake pad dui set bakite dao",
    customer: "Selim Auto",
    part: { part_type: "brake pad", vehicle: "axio", year: "2014", quality: "genuine" },
    quantity: "dui set",
    method: "bakite",
    buy: "Selim Traders theke axio 2014 er genuine brake pad dui set bakite kinlam, proti set 1200 taka",
    supplier: "Selim Traders",
    cost: "1200 taka",
    yes: "ha",
    no: "na",
    none: "nei",
  },
] as const;

/** Taps through the new-name button, a customer's type and নেই for the phone, to the add's sheet. */
async function toAddSheet(shop: ReturnType<typeof connect>, asked: Reply, party: "customer" | "supplier") {
  let reply = await shop.say(asked.state, tap(asked, /^নতুন হিসেবে যোগ করুন$/));
  if (party === "customer") reply = await shop.say(reply.state, tap(reply, /^পাইকারি$/));
  return shop.say(reply.state, tap(reply, /^নেই$/));
}

describe("a new name inside a sale or a stock-in (GearGrid, D173)", () => {
  it.each(SALE)("a sale adds its new customer and goes on with it ($style)", async (said) => {
    const shop = connect(geargrid);
    const asked = await shop.say(
      fresh(),
      { text: said.text },
      call("record_sale", {
        customer: said.customer,
        items: [{ part: said.part, quantity: said.quantity }],
        payment: { method_word: said.method },
      }),
    );
    expect(asked.reply).toMatch(/কার নামে\?$/);
    expect(asked.choices?.options.map((option) => option.label)).toContain("নতুন হিসেবে যোগ করুন");
    const sheet = await toAddSheet(shop, asked, "customer");
    expect(sheet.confirm?.text).toBe(`নতুন কাস্টমার: ${said.customer}, পাইকারি। যোগ করব?`);
    const done = await shop.say(sheet.state, { text: said.yes });
    expect(done.results).toEqual(["done"]);
    expect(done.reply).toMatch(
      new RegExp(`^${said.customer} যোগ হয়েছে। ${said.customer} — .*বাকিতে। ঠিক আছে\\?$`),
    );
    expect(done.confirm?.text).toMatch(new RegExp(`^${said.customer} — `));
    expect(shop.calls.at(-1)).toMatchObject({ path: "/api/v1/sales", query: { dry_run: "true" } });
    expect(lastBody(shop)).toMatchObject({ customer_id: "customer-new" });
  });

  it.each(SALE)("a no to the new name asks the sale's customer again ($style)", async (said) => {
    const shop = connect(geargrid);
    const asked = await shop.say(
      fresh(),
      { text: said.text },
      call("record_sale", {
        customer: said.customer,
        items: [{ part: said.part, quantity: said.quantity }],
        payment: { method_word: said.method },
      }),
    );
    const sheet = await toAddSheet(shop, asked, "customer");
    const again = await shop.say(sheet.state, { text: said.no });
    expect(again.reply).toMatch(/^বাতিল করা হয়েছে, কিছু সেভ হয়নি। .*কার নামে\?$/);
    expect(again.choices?.options.map((option) => option.label)).toContain("নতুন হিসেবে যোগ করুন");
    expect(shop.calls.some((request) => !request.query?.dry_run)).toBe(false);
  });

  it.each(SALE)("a stock-in adds its new supplier and goes on with it ($style)", async (said) => {
    const shop = connect(geargrid);
    const asked = await shop.say(
      fresh(),
      { text: said.buy },
      call("stock_in", {
        supplier: said.supplier,
        items: [{ part: said.part, quantity: said.quantity, unit_cost: said.cost }],
        payment: { method_word: said.method },
      }),
    );
    expect(asked.reply).toMatch(/কার কাছ থেকে\?$/);
    const sheet = await toAddSheet(shop, asked, "supplier");
    expect(sheet.confirm?.text).toBe(`নতুন সাপ্লায়ার: ${said.supplier}। যোগ করব?`);
    const done = await shop.say(sheet.state, { text: said.yes });
    expect(done.reply).toMatch(
      new RegExp(`^${said.supplier} যোগ হয়েছে। ${said.supplier} থেকে .*ঠিক আছে\\?$`),
    );
    expect(lastBody(shop)).toMatchObject({ supplier_id: "supplier-new" });
  });
});

describe("the new customer's and supplier's tools (D173)", () => {
  it("take the name, and only what is said of the rest", () => {
    const keys = (name: string) =>
      Object.keys(
        (writeTool(appCapability(name)).function.parameters as { properties: Record<string, unknown> })
          .properties,
      ).sort();
    expect(keys("add_customer")).toEqual(["address", "name", "phone", "type"]);
    expect(keys("add_supplier")).toEqual(["address", "name", "phone"]);
  });
});

// Run 5 (c-112, c-145): the near-word clean-up turned a new name into a known one ("Bikrampur Motors" into "Mirpur
// Car Care Motors") or into a car ("কাওরান" into "ক্যারাভান"). A new name is new: the clean-up is not asked (D202).
describe("a new name is never cleaned up into a known one (D202)", () => {
  it.each([
    {
      style: "Bangla",
      ask: "রোহিম গ্যারেজের বাকি কত?",
      add: "নতুন কাস্টমার যোগ করেন: রোহিম গ্যারেজ, পাইকারি",
      name: "রোহিম গ্যারেজ",
      tool: "add_customer",
    },
    {
      style: "Banglish",
      ask: "Rohim Garej er baki koto?",
      add: "notun customer add koren: Rohim Garej, paikari",
      name: "Rohim Garej",
      tool: "add_customer",
    },
    {
      style: "Bangla",
      ask: "নবাবপোর অটোর পাওনা কত?",
      add: "নতুন সাপ্লায়ার যোগ করেন: নবাবপোর অটো",
      name: "নবাবপোর অটো",
      tool: "add_supplier",
    },
    {
      style: "Banglish",
      ask: "Nawabpor Autto er paona koto",
      add: "notun supplier jog koren: Nawabpor Autto",
      name: "Nawabpor Autto",
      tool: "add_supplier",
    },
  ])(
    "a $tool keeps the name as said, while a question about it is cleaned up ($style)",
    async ({ ask, add, name, tool }) => {
      const replaced = JSON.stringify({ replaced: [{ heard: name.split(" ")[0], meant: "Rahim Motors" }] });
      const shop = connect(geargrid, { cleanups: [replaced, replaced] });
      const question = await shop.say(fresh(), { text: ask }, [{ text: "" }, { text: "" }]);
      expect(question.cleanups).toHaveLength(1);
      const adding = await shop.say(fresh(), { text: add }, call(tool, { name }));
      expect(adding.cleanups).toEqual([]);
      expect(adding.trace.cleanup).toBeUndefined();
      expect(JSON.stringify(adding.state.frame?.slots.new_name)).toContain(name);
    },
  );
});
