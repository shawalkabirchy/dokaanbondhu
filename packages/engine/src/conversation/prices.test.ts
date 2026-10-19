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
} from "../../test/sale-apps";
import type { Step } from "../../test/scripted-llm";
import { writeTool } from "../write/tool";

// D171: a price change by voice or chat, the owner's alone. The part is asked as for a sale, the new price must be
// said as money, the confirmation says the price from and to, and only that price is sent, in the app's field for
// it, to the path that names the part. In Bangla and in Banglish (D96), on the three app shapes of D167; the fake
// apps' prices are 1,600 taka retail and 1,500 paikari.

/** The buttons that lead each app's request to one part. */
const TO_ONE_PART: Record<string, RegExp[]> = {
  GearGrid: [/ফিল্ডার/, /^2012–2017$/],
  "shop B": [/^Axio$/, /^2012–2017$/, /নন-জেনুইন/],
  "an app with its own words": [/Tucson/i, /Platinum/i],
};
const PART: Record<string, string> = {
  GearGrid: "pad-new",
  "shop B": "2",
  "an app with its own words": "tc-platinum",
};

const PRICE = [
  {
    style: "Bangla",
    text: "ব্রেক প্যাডের দাম ১৭০০ টাকা করো",
    args: { part: { part_type: "ব্রেক প্যাড" }, prices: { retail: "১৭০০ টাকা" } },
    fielder: "ফিল্ডারের ব্রেক প্যাডের দাম ১৭০০ টাকা করো",
    fielderArgs: { part: { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার" }, prices: { retail: "১৭০০ টাকা" } },
    paikari: "ফিল্ডারের ব্রেক প্যাডের পাইকারি দাম ১৪০০ টাকা করো",
    paikariArgs: { part: { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার" }, prices: { paikari: "১৪০০ টাকা" } },
    noPrice: "ফিল্ডারের ব্রেক প্যাডের দাম বদলাও",
    answer: "১৭০০ টাকা",
  },
  {
    style: "Banglish",
    text: "brake pad er dam 1700 koro",
    args: { part: { part_type: "brake pad" }, prices: { retail: "1700" } },
    fielder: "fielder er brake pad er dam 1700 koro",
    fielderArgs: { part: { part_type: "brake pad", vehicle: "fielder" }, prices: { retail: "1700" } },
    paikari: "fielder er brake pad er paikari dam 1400 koro",
    paikariArgs: { part: { part_type: "brake pad", vehicle: "fielder" }, prices: { paikari: "1400" } },
    noPrice: "fielder er brake pad er dam bodlao",
    answer: "1700 taka",
  },
] as const;

const priceCall = (args: object): Step[] => [{ calls: [{ name: "update_price", arguments: { ...args } }] }];

async function tapAll(shop: ReturnType<typeof connect>, reply: Reply, labels: RegExp[]): Promise<Reply> {
  let current = reply;
  for (const label of labels) current = await shop.say(current.state, tap(current, label));
  return current;
}

for (const app of [geargrid, shopB, ownWords]) {
  describe(`${app.name}: a price change (D171)`, () => {
    it.each(PRICE)("asks the part, then confirms the retail price from and to ($style)", async (said) => {
      const shop = connect(app, { role: "owner" });
      const first = await shop.say(fresh(), { text: said.text }, priceCall(said.args));
      const reply = await tapAll(shop, first, TO_ONE_PART[app.name]!);
      expect(reply.asked).toBeUndefined();
      expect(reply.confirm?.text).toMatch(/ব্রেক প্যাডের খুচরা দাম ১,৬০০ টাকা থেকে ১,৭০০ টাকা। ঠিক আছে\?$/);
      expect(reply.confirm?.fields).toEqual(
        expect.arrayContaining([
          { label: "দাম", value: "খুচরা", highlight: false },
          { label: "আগে", value: "১,৬০০ টাকা", highlight: false },
          { label: "নতুন", value: "১,৭০০ টাকা", highlight: false },
        ]),
      );
      // The app has no dry run for prices: nothing is sent before yes.
      expect(shop.calls).toHaveLength(0);
      expect(reply.state.action?.request).toEqual({
        method: "PATCH",
        path: `/api/v1/parts/${PART[app.name]}/price`,
        query: {},
        body: { retail_price_taka: 1700 },
      });
    });
  });
}

describe("which price, how much, and who may (GearGrid, D171)", () => {
  it.each(PRICE)("the paikari price goes to the app's paikari field ($style)", async (said) => {
    const shop = connect(geargrid, { role: "owner" });
    const first = await shop.say(fresh(), { text: said.paikari }, priceCall(said.paikariArgs));
    const reply = await shop.say(first.state, tap(first, /^2012–2017$/));
    expect(reply.confirm?.text).toBe(
      "ফিল্ডারের সামনের ব্রেক প্যাডের পাইকারি দাম ১,৫০০ টাকা থেকে ১,৪০০ টাকা। ঠিক আছে?",
    );
    expect(reply.state.action?.request.body).toEqual({ garage_price_taka: 1400 });
  });

  it.each(PRICE)("the request's পাইকারি wins over the model's kind ($style)", async (said) => {
    const shop = connect(geargrid, { role: "owner" });
    const args = { ...said.paikariArgs, prices: { retail: said.paikariArgs.prices.paikari } };
    const first = await shop.say(fresh(), { text: said.paikari }, priceCall(args));
    const reply = await shop.say(first.state, tap(first, /^2012–2017$/));
    expect(reply.state.action?.request.body).toEqual({ garage_price_taka: 1400 });
  });

  it.each(PRICE)("no price said: asks the new one, and takes the answer ($style)", async (said) => {
    const shop = connect(geargrid, { role: "owner" });
    const first = await shop.say(fresh(), { text: said.noPrice }, priceCall({ part: said.fielderArgs.part }));
    const asked = await shop.say(first.state, tap(first, /^2012–2017$/));
    expect(asked.reply).toMatch(/নতুন খুচরা দাম কত\?$/);
    const reply = await shop.say(asked.state, { text: said.answer });
    expect(reply.confirm?.text).toMatch(/খুচরা দাম ১,৬০০ টাকা থেকে ১,৭০০ টাকা। ঠিক আছে\?$/);
  });

  it.each(PRICE)("a price the owner never said is not taken from the model ($style)", async (said) => {
    const shop = connect(geargrid, { role: "owner" });
    const args = { ...said.fielderArgs, prices: { retail: "1900" } };
    const first = await shop.say(fresh(), { text: said.fielder }, priceCall(args));
    const asked = await shop.say(first.state, tap(first, /^2012–2017$/));
    expect(asked.reply).toMatch(/নতুন খুচরা দাম কত\?$/);
  });

  it.each(PRICE)("started from the words when the model searches instead ($style)", async (said) => {
    const shop = connect(geargrid, { role: "owner" });
    const search: Step[] = [{ calls: [{ name: "find_parts", arguments: { ...said.fielderArgs.part } }] }];
    const first = await shop.say(fresh(), { text: said.fielder }, search);
    const reply = await shop.say(first.state, tap(first, /^2012–2017$/));
    expect(reply.confirm?.text).toMatch(/খুচরা দাম ১,৬০০ টাকা থেকে ১,৭০০ টাকা। ঠিক আছে\?$/);
  });

  it.each(PRICE)("staff are told only the owner may, and nothing changes ($style)", async (said) => {
    const shop = connect(geargrid);
    const reply = await shop.say(fresh(), { text: said.fielder }, priceCall(said.fielderArgs));
    expect(reply.reply).toBe("দাম বদলাতে পারেন শুধু দোকানের মালিক।");
    expect(reply.asked).toBeUndefined();
    expect(reply.confirm).toBeUndefined();
    expect(shop.calls).toHaveLength(0);
  });
});

describe("the price change's tool (D171)", () => {
  it("names the part, which it reads from the path, and the prices of the owner's two kinds", () => {
    const tool = writeTool(appCapability("update_price"));
    const parameters = tool.function.parameters as {
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
    expect(Object.keys(parameters.properties).sort()).toEqual(["part", "prices"]);
    expect(Object.keys(parameters.properties.prices!.properties!).sort()).toEqual(["paikari", "retail"]);
  });
});
