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
  type ShopSale,
} from "../../test/sale-apps";
import type { Step } from "../../test/scripted-llm";
import { writeTool } from "../write/tool";

// D169: a return by voice or chat. The owner says what came back; the part is asked as for a sale, then who gave it
// back, then the sale is found among that customer's sales of the part in the last 30 days, the refund follows the
// default rule (off the due, else in cash), and the confirmation says the sale's day. In Bangla and in Banglish (D96),
// on the three app shapes of D167; the tests' now is 15 Oct 2026, noon in Dhaka.

/** The buttons that lead each app's request to one part. */
const TO_ONE_PART: Record<string, RegExp[]> = {
  GearGrid: [/ফিল্ডার/, /^2012–2017$/],
  "shop B": [/^Axio$/, /^2012–2017$/, /নন-জেনুইন/],
  "an app with its own words": [/Tucson/i, /Platinum/i],
};
/** That part on each app. */
const PART: Record<string, string> = {
  GearGrid: "pad-new",
  "shop B": "2",
  "an app with its own words": "tc-platinum",
};

const sale = (fields: Partial<ShopSale> & { partId: string }): ShopSale => ({
  id: "sale-1",
  lineId: "line-1",
  customerId: "c1",
  quantity: 2,
  unitPrice: 1600,
  due: 3200,
  daysAgo: 3,
  ...fields,
});

const RETURN = [
  {
    style: "Bangla",
    text: "রহিম মোটরস ব্রেক প্যাড এক সেট ফেরত দিয়েছে",
    args: { customer: "রহিম মোটরস", items: [{ part: { part_type: "ব্রেক প্যাড" }, quantity: "এক সেট" }] },
    noName: "একটা ব্রেক প্যাড ফেরত নাও",
    noNameArgs: { items: [{ part: { part_type: "ব্রেক প্যাড" } }] },
    yesterday: "রহিম মোটরস গতকালের ব্রেক প্যাড এক সেট ফেরত দিয়েছে",
    three: "রহিম মোটরস ব্রেক প্যাড তিন সেট ফেরত দিয়েছে",
    threeArgs: {
      customer: "রহিম মোটরস",
      items: [{ part: { part_type: "ব্রেক প্যাড" }, quantity: "তিন সেট" }],
    },
    one: "এক সেট",
    damaged: "রহিম মোটরস ব্রেক প্যাড এক সেট ফেরত দিয়েছে, নষ্ট",
    noQuantity: "রহিম মোটরস ব্রেক প্যাড ফেরত দিয়েছে",
    noQuantityArgs: { customer: "রহিম মোটরস", items: [{ part: { part_type: "ব্রেক প্যাড" } }] },
  },
  {
    style: "Banglish",
    text: "Rohim Motors brake pad ek set ferot dise",
    args: { customer: "Rohim Motors", items: [{ part: { part_type: "brake pad" }, quantity: "ek set" }] },
    noName: "ekta brake pad ferot nao",
    noNameArgs: { items: [{ part: { part_type: "brake pad" } }] },
    yesterday: "Rohim Motors gotokal er brake pad ek set ferot dise",
    three: "Rohim Motors brake pad tin set ferot dise",
    threeArgs: {
      customer: "Rohim Motors",
      items: [{ part: { part_type: "brake pad" }, quantity: "tin set" }],
    },
    one: "ek set",
    damaged: "Rohim Motors brake pad ek set ferot dise, kharap",
    noQuantity: "Rohim Motors brake pad ferot dise",
    noQuantityArgs: { customer: "Rohim Motors", items: [{ part: { part_type: "brake pad" } }] },
  },
] as const;

const returnCall = (args: object): Step[] => [{ calls: [{ name: "record_return", arguments: { ...args } }] }];

/** Says the request and taps the app's way to its one part. */
async function toPart(
  shop: ReturnType<typeof connect>,
  app: string,
  text: string,
  args: object,
): Promise<Reply> {
  let reply = await shop.say(fresh(), { text }, returnCall(args));
  for (const label of TO_ONE_PART[app]!) reply = await shop.say(reply.state, tap(reply, label));
  return reply;
}

/** The last call's body, as the host would get it. */
const lastBody = (shop: ReturnType<typeof connect>) => shop.calls.at(-1)?.body as Record<string, unknown>;

for (const app of [geargrid, shopB, ownWords]) {
  const withSales = (sales: ShopSale[], customerDue = 19200): Shop => ({ ...app, sales, customerDue });
  const part = PART[app.name]!;

  describe(`${app.name}: a return (D169)`, () => {
    it.each(RETURN)("finds the one sale and refunds off the due ($style)", async (said) => {
      const shop = connect(withSales([sale({ partId: part })]));
      const reply = await toPart(shop, app.name, said.text, said.args);
      expect(reply.asked).toBeUndefined();
      expect(reply.confirm?.text).toMatch(
        /^Rahim Motors — ১২ অক্টোবরের .*১ সেট, ১,৬০০ টাকা ফেরত, বাকি থেকে কাটা হবে। ঠিক আছে\?$/,
      );
      expect(reply.confirm?.fields).toEqual(
        expect.arrayContaining([
          { label: "বিক্রির দিন", value: "১২ অক্টোবর", highlight: false },
          { label: "ফেরত", value: "১,৬০০ টাকা", highlight: false },
          { label: "কীভাবে", value: "বাকি থেকে কাটা হবে", highlight: false },
        ]),
      );
      // A first dry run without the refund reads the total, then the one with it.
      expect(shop.calls).toHaveLength(2);
      expect(shop.calls[0]!.body).not.toHaveProperty("refund_due_taka");
      expect(lastBody(shop)).toEqual({
        sale_id: "sale-1",
        items: [{ sale_item_id: "line-1", quantity: 1 }],
        refund_due_taka: 1600,
        refund_cash_taka: 0,
      });
    });
  });
}

describe("which sale, how much and how the money goes back (GearGrid, D169)", () => {
  const app = geargrid.name;
  const shopWith = (sales: ShopSale[], customerDue = 19200) => connect({ ...geargrid, sales, customerDue });

  it.each(RETURN)("a sale paid in full goes back in cash ($style)", async (said) => {
    const shop = shopWith([sale({ partId: "pad-new", due: 0 })]);
    const reply = await toPart(shop, app, said.text, said.args);
    expect(reply.confirm?.text).toMatch(/১,৬০০ টাকা ফেরত, নগদ ফেরত। ঠিক আছে\?$/);
    expect(lastBody(shop)).toMatchObject({ refund_due_taka: 0, refund_cash_taka: 1600 });
  });

  it.each(RETURN)("a due smaller than the return: off the due, the rest in cash ($style)", async (said) => {
    const shop = shopWith([sale({ partId: "pad-new" })], 1000);
    const reply = await toPart(shop, app, said.text, said.args);
    expect(reply.confirm?.text).toMatch(/বাকি থেকে ১,০০০ টাকা, নগদ ৬০০ টাকা। ঠিক আছে\?$/);
    expect(lastBody(shop)).toMatchObject({ refund_due_taka: 1000, refund_cash_taka: 600 });
  });

  it.each(RETURN)(
    "two sales: asks which day, newest first, and takes the tapped one ($style)",
    async (said) => {
      const shop = shopWith([
        sale({ partId: "pad-new", id: "sale-old", lineId: "line-old", quantity: 1, daysAgo: 6 }),
        sale({ partId: "pad-new", id: "sale-new", lineId: "line-new", quantity: 2, daysAgo: 1 }),
      ]);
      const asked = await toPart(shop, app, said.text, said.args);
      expect(asked.reply).toBe("কোন দিনের বিক্রি?");
      expect(asked.choices?.options.map((option) => option.label)).toEqual([
        "গতকাল, ২ সেট",
        "৯ অক্টোবর, ১ সেট",
      ]);
      const reply = await shop.say(asked.state, tap(asked, /৯ অক্টোবর/));
      expect(reply.confirm?.text).toMatch(/^Rahim Motors — ৯ অক্টোবরের /);
      expect(lastBody(shop)).toMatchObject({ sale_id: "sale-old", items: [{ sale_item_id: "line-old" }] });
    },
  );

  it.each(RETURN)("a day said with the request picks that day's sale ($style)", async (said) => {
    const shop = shopWith([
      sale({ partId: "pad-new", id: "sale-old", lineId: "line-old", daysAgo: 6 }),
      sale({ partId: "pad-new", id: "sale-new", lineId: "line-new", daysAgo: 1 }),
    ]);
    const reply = await toPart(shop, app, said.yesterday, said.args);
    expect(reply.asked).toBeUndefined();
    expect(reply.confirm?.text).toMatch(/^Rahim Motors — গতকালের /);
    expect(lastBody(shop)).toMatchObject({ sale_id: "sale-new" });
  });

  it.each(RETURN)("no sale in 30 days: says so, and nothing is sent ($style)", async (said) => {
    const shop = shopWith([]);
    const reply = await toPart(shop, app, said.text, said.args);
    expect(reply.asked).toBeUndefined();
    expect(reply.confirm).toBeUndefined();
    expect(reply.reply).toBe("Rahim Motors-এর কাছে গত ৩০ দিনে ফিল্ডারের সামনের ব্রেক প্যাড বিক্রি পাইনি।");
    expect(shop.calls).toHaveLength(0);
  });

  it.each(RETURN)("a line returned in full already is not offered ($style)", async (said) => {
    const shop = shopWith([sale({ partId: "pad-new", returned: 2 })]);
    const reply = await toPart(shop, app, said.text, said.args);
    expect(reply.reply).toMatch(/বিক্রি পাইনি।$/);
  });

  it.each(RETURN)("more than the line has left: asks again, saying what it had ($style)", async (said) => {
    const shop = shopWith([sale({ partId: "pad-new", quantity: 2 })]);
    const asked = await toPart(shop, app, said.three, said.threeArgs);
    expect(asked.reply).toBe("ওই বিক্রিতে ২ সেট ছিল — কয় সেট ফেরত?");
    const reply = await shop.say(asked.state, { text: said.one });
    expect(reply.confirm?.text).toMatch(/১ সেট, ১,৬০০ টাকা ফেরত/);
  });

  it.each(RETURN)("a line of one needs no quantity ($style)", async (said) => {
    const shop = shopWith([sale({ partId: "pad-new", quantity: 1 })]);
    const reply = await toPart(shop, app, said.noQuantity, said.noQuantityArgs);
    expect(reply.asked).toBeUndefined();
    expect(reply.confirm?.text).toMatch(/১ সেট, ১,৬০০ টাকা ফেরত/);
  });

  it.each(RETURN)(
    "no name: asks who, with a button for a walk-in, refunded in cash ($style)",
    async (said) => {
      const shop = shopWith([sale({ partId: "pad-new", customerId: null, quantity: 1, due: 0 })]);
      const asked = await toPart(shop, app, said.noName, said.noNameArgs);
      expect(asked.reply).toMatch(/কে ফেরত দিল\?$/);
      expect(asked.choices?.options.map((option) => option.label)).toContain("নাম ছাড়া কেনা");
      const reply = await shop.say(asked.state, tap(asked, /নাম ছাড়া কেনা/));
      expect(reply.confirm?.text).toMatch(/^১২ অক্টোবরের .*১,৬০০ টাকা ফেরত, নগদ ফেরত। ঠিক আছে\?$/);
      expect(reply.confirm?.fields).toContainEqual({
        label: "কাস্টমার",
        value: "নাম ছাড়া কেনা",
        highlight: false,
      });
      expect(lastBody(shop)).toMatchObject({ refund_due_taka: 0, refund_cash_taka: 1600 });
    },
  );

  it.each(RETURN)("no walk-in sale of the part: says so ($style)", async (said) => {
    const shop = shopWith([sale({ partId: "pad-new" })]);
    const asked = await toPart(shop, app, said.noName, said.noNameArgs);
    const reply = await shop.say(asked.state, tap(asked, /নাম ছাড়া কেনা/));
    expect(reply.reply).toBe("গত ৩০ দিনে নাম ছাড়া ফিল্ডারের সামনের ব্রেক প্যাড বিক্রি পাইনি।");
    expect(shop.calls).toHaveLength(0);
  });

  it.each(RETURN)("the walk-in answered in words ($style)", async (said) => {
    const shop = shopWith([sale({ partId: "pad-new", customerId: null, quantity: 1, due: 0 })]);
    const asked = await toPart(shop, app, said.noName, said.noNameArgs);
    const reply = await shop.say(asked.state, { text: said.style === "Bangla" ? "নাম ছাড়া" : "walk in" });
    expect(reply.confirm?.text).toMatch(/নগদ ফেরত। ঠিক আছে\?$/);
  });

  it.each(RETURN)("a part said damaged stays out of stock ($style)", async (said) => {
    const shop = shopWith([sale({ partId: "pad-new" })]);
    await toPart(shop, app, said.damaged, said.args);
    expect(lastBody(shop)).toMatchObject({
      items: [{ sale_item_id: "line-1", quantity: 1, restock: "damaged" }],
    });
  });
});

describe("the return's tool (D169)", () => {
  it("asks the model for who bought it and when, with the part in items", () => {
    const tool = writeTool(appCapability("record_return"));
    const properties = (tool.function.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual(["customer", "items", "reason", "when"]);
  });
});
