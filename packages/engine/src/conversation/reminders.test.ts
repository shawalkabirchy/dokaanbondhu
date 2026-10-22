import { describe, expect, it } from "vitest";
import { connect, fresh, geargrid, ownWords, shopB, type Shop, type ShopSale } from "../../test/sale-apps";
import type { Step } from "../../test/scripted-llm";

// D194: parts running low and customers' old dues, asked by voice or chat. A clear question is answered at once from
// the app's own tables (no LLM), a vaguer one through the model's get_reminders; either way the sentence says how many
// (names only when few and in Bangla) and the list is a table on the screen. A question that names a part, a car or a
// customer is about that one. In Bangla and in Banglish (D96), on the three app shapes of D167; the tests' now is
// 15 Oct 2026.

const ASK = [
  {
    style: "Bangla",
    low: "কী কী কম আছে?",
    old: "কার বাকি পুরোনো?",
    vagueLow: "দোকানে কোন মাল আনতে হবে?",
    oneCustomer: "রহিম মোটরসের বাকি পুরোনো?",
  },
  {
    style: "Banglish",
    low: "ki ki kom ache?",
    old: "kar baki purono?",
    vagueLow: "dokane kon mal ante hobe?",
    oneCustomer: "rahim motors er baki purono?",
  },
] as const;

const sale = (app: Shop, id: string, due: number, daysAgo: number, partIndex = 0): ShopSale => ({
  id,
  lineId: `${id}-line`,
  partId: app.parts[partIndex]!.id,
  customerId: "c1",
  quantity: 1,
  unitPrice: due,
  due,
  daysAgo,
});

/** The app with its first part at 1 against a reorder level of 2, the others at 4. */
const lowOne = (app: Shop): Shop => ({
  ...app,
  stock: { [app.parts[0]!.id]: 1 },
  reorder: Object.fromEntries(app.parts.map((part) => [part.id, 2])),
});

const remindersCall = (kind: string): Step[] => [{ calls: [{ name: "get_reminders", arguments: { kind } }] }];

for (const app of [geargrid, shopB, ownWords]) {
  describe(`${app.name}: reminders (D194)`, () => {
    it.each(ASK)("a part at or below its reorder level is low, at once ($style)", async (said) => {
      const shop = connect(lowOne(app));
      const reply = await shop.say(fresh(), { text: said.low });
      expect(reply.reply).toBe("১টি পার্ট কম আছে। বিস্তারিত স্ক্রিনে দেখুন।");
      expect(reply.trace.llm_calls).toBe(0);
      expect(reply.trace.tool_calls.map((call) => call.name)).toEqual(["get_reminders"]);
      expect(reply.tables).toHaveLength(1);
      expect(reply.tables[0]!.title).toBe("কম স্টক");
      expect(reply.tables[0]!.rows).toEqual([[app.parts[0]!.name, 1, 2]]);
    });

    it.each(ASK)(
      "without a reorder level, an empty part is low only when it sold lately ($style)",
      async (said) => {
        const shop = connect({
          ...app,
          stock: Object.fromEntries(app.parts.slice(0, 2).map((part) => [part.id, 0])),
          sales: [{ ...sale(app, "s1", 0, 20), customerId: null }],
        });
        const reply = await shop.say(fresh(), { text: said.low });
        expect(reply.reply).toBe("১টি পার্ট কম আছে। বিস্তারিত স্ক্রিনে দেখুন।");
        expect(reply.tables[0]!.rows).toEqual([[app.parts[0]!.name, 0, 0]]);
      },
    );

    it.each(ASK)("nothing low: said so, and no table ($style)", async (said) => {
      const shop = connect(app);
      const reply = await shop.say(fresh(), { text: said.low });
      expect(reply.reply).toBe("এখন কোনো পার্ট কম নেই।");
      expect(reply.tables).toHaveLength(0);
    });

    it.each(ASK)(
      "a due partly from a sale older than 30 days is old, with its age ($style)",
      async (said) => {
        const shop = connect({
          ...app,
          customerDue: 5000,
          sales: [sale(app, "s1", 2000, 10), sale(app, "s2", 3000, 45)],
        });
        const reply = await shop.say(fresh(), { text: said.old });
        expect(reply.reply).toBe(
          "১ জনের বাকি ৩০ দিনের বেশি পুরোনো, মোট ৩,০০০ টাকা: রহিম মোটরস। বিস্তারিত স্ক্রিনে দেখুন।",
        );
        expect(reply.trace.llm_calls).toBe(0);
        expect(reply.tables[0]!.title).toBe("পুরোনো বাকি");
        expect(reply.tables[0]!.rows).toEqual([["রহিম মোটরস", 5000, 3000, "৪৫ দিন"]]);
      },
    );

    it.each(ASK)("a due from before every sale is old, from the start ($style)", async (said) => {
      const shop = connect({ ...app, customerDue: 5000, sales: [sale(app, "s1", 2000, 10)] });
      const reply = await shop.say(fresh(), { text: said.old });
      expect(reply.reply).toMatch(/^১ জনের বাকি ৩০ দিনের বেশি পুরোনো, মোট ৩,০০০ টাকা/);
      expect(reply.tables[0]!.rows).toEqual([["রহিম মোটরস", 5000, 3000, "শুরুর বাকি"]]);
    });

    it.each(ASK)("a due from this month only is not old ($style)", async (said) => {
      const shop = connect({ ...app, customerDue: 2000, sales: [sale(app, "s1", 2000, 10)] });
      const reply = await shop.say(fresh(), { text: said.old });
      expect(reply.reply).toBe("৩০ দিনের বেশি পুরোনো বাকি কারো নেই।");
      expect(reply.tables).toHaveLength(0);
    });

    it.each(ASK)("a vaguer question goes through the model's get_reminders ($style)", async (said) => {
      const shop = connect(lowOne(app), { role: "owner" });
      const reply = await shop.say(fresh(), { text: said.vagueLow }, remindersCall("low_stock"));
      expect(reply.reply).toBe("১টি পার্ট কম আছে। বিস্তারিত স্ক্রিনে দেখুন।");
      expect(reply.trace.llm_calls).toBe(1);
      expect(reply.tables).toHaveLength(1);
    });
  });
}

describe("what is not a reminder question (GearGrid, D194)", () => {
  it.each(ASK)("one customer's due goes to the model, not the quick list ($style)", async (said) => {
    const shop = connect({ ...geargrid, customerDue: 5000, sales: [sale(geargrid, "s1", 3000, 45)] });
    const reply = await shop.say(fresh(), { text: said.oneCustomer }, remindersCall("old_dues"));
    expect(reply.trace.llm_calls).toBe(1);
  });

  it("a part and car named is a part search, and the reminders are never said on their own", async () => {
    const shop = connect(lowOne(geargrid));
    for (const [text, args] of [
      ["ফিল্ডারের ব্রেক প্যাড কম আছে?", { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার" }],
      ["fielder er brake pad kom ache?", { part_type: "brake pad", vehicle: "fielder" }],
    ] as const) {
      const reply = await shop.say(fresh(), { text }, [
        { calls: [{ name: "find_parts", arguments: { ...args } }] },
      ]);
      expect(reply.trace.tool_calls.map((call) => call.name)).toEqual(["find_parts"]);
      expect(reply.reply).not.toMatch(/কম আছে|পুরোনো/);
      expect(reply.tables).toHaveLength(0);
    }
  });
});
