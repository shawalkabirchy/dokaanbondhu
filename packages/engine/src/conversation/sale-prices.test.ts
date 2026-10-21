import { describe, expect, it } from "vitest";
import {
  appCapability,
  connect,
  fresh,
  geargrid,
  ownWords,
  shopB,
  type Api,
  type ApiAnswer,
  type Shop,
} from "../../test/sale-apps";
import type { Step } from "../../test/scripted-llm";
import { writeTool } from "../write/tool";

// D176, D177: a sale at a price the user sets. "৩০০০ টাকায়" is the price of what the line says, "১৫০০ টাকা করে" or
// "প্রতি সেট" the price of one; said as money, never a payment's amount. The owner may always; staff only when the
// owner allows; otherwise refused at once. In Bangla and in Banglish (D96), on the three app shapes of D167.

/** The app's dry run as GearGrid prices it: the said unit price, else the shop's 1,600 a set. */
const priced: ApiAnswer = async (request) => {
  const item = (request.body as { items?: { quantity?: number; unit_price_taka?: number }[] }).items?.[0];
  return {
    status: 200,
    headers: new Headers(),
    body: { sale: { total_taka: (item?.unit_price_taka ?? 1600) * (item?.quantity ?? 1) }, warnings: [] },
  };
};

const saleCall = (args: object): Step[] => [{ calls: [{ name: "record_sale", arguments: { ...args } }] }];
const shopFor = (app: Shop, api: Api = {}) => connect(app, { answer: priced, role: "owner", ...api });
const line = (shop: ReturnType<typeof connect>) =>
  (shop.calls.at(-1)?.body as { items: Record<string, unknown>[] }).items[0]!;

/** Each app's part, said as its own words name it. */
const PARTS: { app: Shop; bangla: [string, object]; banglish: [string, object] }[] = [
  {
    app: geargrid,
    bangla: ["ফিল্ডার ২০১৫-এর ব্রেক প্যাড", { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার", year: "২০১৫" }],
    banglish: ["fielder 2015 er brake pad", { part_type: "brake pad", vehicle: "fielder", year: "2015" }],
  },
  {
    app: shopB,
    bangla: ["ফিল্ডার ২০১৫-এর ব্রেক প্যাড", { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার", year: "২০১৫" }],
    banglish: ["fielder 2015 er brake pad", { part_type: "brake pad", vehicle: "fielder", year: "2015" }],
  },
  {
    app: ownWords,
    bangla: [
      "Tucson-এর Platinum ব্রেক প্যাড",
      { part_type: "ব্রেক প্যাড", vehicle: "Tucson", quality: "Platinum" },
    ],
    banglish: [
      "tucson er platinum brake pad",
      { part_type: "brake pad", vehicle: "tucson", quality: "platinum" },
    ],
  },
];

/** A credit sale to Rahim Motors of the part, with what the request says of its price. */
function said(style: "Bangla" | "Banglish", part: [string, object], price: { bn: string; en: string }) {
  return style === "Bangla"
    ? {
        text: `রহিম মোটরসকে ${part[0]} দুই সেট ${price.bn} বাকিতে দাও`,
        args: {
          customer: "রহিম মোটরস",
          items: [{ part: part[1], quantity: "দুই সেট", price: price.bn }],
          payment: { method_word: "বাকিতে" },
        },
        no: "না, ১৪০০ টাকা করে",
      }
    : {
        text: `Rahim Motors ke ${part[0]} dui set ${price.en} bakite dao`,
        args: {
          customer: "Rahim Motors",
          items: [{ part: part[1], quantity: "dui set", price: price.en }],
          payment: { method_word: "bakite" },
        },
        no: "na, 1400 taka kore",
      };
}

const STYLES = ["Bangla", "Banglish"] as const;
const LINE = { bn: "৩০০০ টাকায়", en: "3000 takay" };
const EACH = { bn: "১৫০০ টাকা করে", en: "1500 taka kore" };

for (const { app, bangla, banglish } of PARTS) {
  const partOf = (style: (typeof STYLES)[number]) => (style === "Bangla" ? bangla : banglish);
  describe(`${app.name}: a sale at a price the owner sets (D176)`, () => {
    it.each(STYLES)(
      "“৩০০০ টাকায়” is the line's: 1,500 a set, the shop's own beside it (%s)",
      async (style) => {
        const shop = shopFor(app);
        const request = said(style, partOf(style), LINE);
        const reply = await shop.say(fresh(), { text: request.text }, saleCall(request.args));
        expect(reply.confirm?.text).toMatch(/২ সেট, প্রতি সেট ১,৫০০ টাকা, ৩,০০০ টাকা, বাকিতে। ঠিক আছে\?$/);
        expect(reply.confirm?.fields).toContainEqual({
          label: "দাম",
          value: "প্রতি সেট ১,৫০০ টাকা (দোকানের দাম ১,৬০০ টাকা)",
          highlight: false,
        });
        expect(line(shop)).toMatchObject({ quantity: 2, unit_price_taka: 1500 });
      },
    );

    it.each(STYLES)("“১৫০০ টাকা করে” is one's (%s)", async (style) => {
      const shop = shopFor(app);
      const request = said(style, partOf(style), EACH);
      const reply = await shop.say(fresh(), { text: request.text }, saleCall(request.args));
      expect(reply.confirm?.text).toMatch(/প্রতি সেট ১,৫০০ টাকা, ৩,০০০ টাকা, বাকিতে/);
      expect(line(shop)).toMatchObject({ quantity: 2, unit_price_taka: 1500 });
    });
  });
}

describe("who may set a sale's price, and what is a price (GearGrid, D176, D177)", () => {
  const part = (style: (typeof STYLES)[number]) =>
    style === "Bangla" ? PARTS[0]!.bangla : PARTS[0]!.banglish;

  it.each(STYLES)(
    "staff are refused at once while the owner has not allowed it, and nothing is sent (%s)",
    async (style) => {
      const shop = shopFor(geargrid, { role: "staff" });
      const request = said(style, part(style), LINE);
      const reply = await shop.say(fresh(), { text: request.text }, saleCall(request.args));
      expect(reply.reply).toBe("অন্য দামে বেচতে পারেন শুধু দোকানের মালিক।");
      expect(reply.confirm).toBeUndefined();
      expect(shop.calls).toHaveLength(0);
    },
  );

  it.each(STYLES)("staff may once the owner allows it (%s)", async (style) => {
    const shop = shopFor(geargrid, { role: "staff", staffPriceOverride: true });
    const request = said(style, part(style), LINE);
    const reply = await shop.say(fresh(), { text: request.text }, saleCall(request.args));
    expect(reply.confirm?.text).toMatch(/প্রতি সেট ১,৫০০ টাকা/);
    expect(line(shop)).toMatchObject({ unit_price_taka: 1500 });
  });

  it.each(STYLES)("a payment's amount is no price, and a price is no payment (%s)", async (style) => {
    const shop = shopFor(geargrid);
    const text =
      style === "Bangla"
        ? "রহিম মোটরসকে ফিল্ডার ২০১৫-এর ব্রেক প্যাড দুই সেট দাও, ১০০০ টাকা নগদ দিল"
        : "Rahim Motors ke fielder 2015 er brake pad dui set dao, 1000 taka nogod dilo";
    const paid = await shop.say(
      fresh(),
      { text },
      saleCall({
        customer: style === "Bangla" ? "রহিম মোটরস" : "Rahim Motors",
        items: [{ part: part(style)[1], quantity: style === "Bangla" ? "দুই সেট" : "dui set" }],
        payment: {
          method_word: style === "Bangla" ? "নগদ" : "nogod",
          amount: style === "Bangla" ? "১০০০ টাকা" : "1000 taka",
        },
      }),
    );
    expect(paid.confirm).toBeDefined();
    expect(line(shop).unit_price_taka).toBeUndefined();
    // The model put the said price into the payment too: it is dropped, and the sale stays on credit.
    const other = shopFor(geargrid);
    const request = said(style, part(style), LINE);
    const args = {
      ...request.args,
      payment: {
        method_word: request.args.payment.method_word,
        amount: style === "Bangla" ? "৩০০০ টাকা" : "3000",
      },
    };
    await other.say(fresh(), { text: request.text }, saleCall(args));
    expect(other.calls.at(-1)?.body).toMatchObject({ items: [{ unit_price_taka: 1500 }] });
    expect((other.calls.at(-1)?.body as { payments?: unknown[] }).payments ?? []).toEqual([]);
  });

  it.each(STYLES)("a line's price that is no whole taka a set asks the price of one (%s)", async (style) => {
    const shop = shopFor(geargrid);
    const text =
      style === "Bangla"
        ? "রহিম মোটরসকে ফিল্ডার ২০১৫-এর ব্রেক প্যাড তিন সেট ১০০০ টাকায় বাকিতে দাও"
        : "Rahim Motors ke fielder 2015 er brake pad tin set 1000 takay bakite dao";
    const args = {
      customer: style === "Bangla" ? "রহিম মোটরস" : "Rahim Motors",
      items: [{ part: part(style)[1], quantity: style === "Bangla" ? "তিন সেট" : "tin set" }],
      payment: { method_word: style === "Bangla" ? "বাকিতে" : "bakite" },
    };
    const asked = await shop.say(fresh(), { text }, saleCall(args));
    expect(asked.reply).toMatch(/প্রতি সেট দাম কত\?$/);
    const reply = await shop.say(asked.state, { text: style === "Bangla" ? "৩৩০ টাকা" : "330 taka" });
    expect(reply.confirm?.text).toMatch(/৩ সেট, প্রতি সেট ৩৩০ টাকা, ৯৯০ টাকা/);
    expect(line(shop)).toMatchObject({ quantity: 3, unit_price_taka: 330 });
  });

  it.each(STYLES)("“না, ১৪০০ টাকা করে” on the sheet changes the price (%s)", async (style) => {
    const shop = shopFor(geargrid);
    const request = said(style, part(style), LINE);
    const first = await shop.say(fresh(), { text: request.text }, saleCall(request.args));
    const reply = await shop.say(first.state, { text: request.no });
    expect(reply.confirm?.text).toMatch(/প্রতি সেট ১,৪০০ টাকা, ২,৮০০ টাকা, বাকিতে/);
    expect(line(shop)).toMatchObject({ unit_price_taka: 1400 });
  });

  it.each(STYLES)("an app whose sale takes no price says so, and nothing is sent (%s)", async (style) => {
    const shop = shopFor(geargrid, { noUnitPrice: true });
    const request = said(style, part(style), LINE);
    const reply = await shop.say(fresh(), { text: request.text }, saleCall(request.args));
    expect(reply.reply).toBe("এই অ্যাপে অন্য দামে বিক্রি করা যায় না।");
    expect(shop.calls).toHaveLength(0);
  });
});

// The owner's G21 by voice (21 Oct, D178): "তিন হাজার টাকায়" was written "তিন হাউজার টাকায়"; the price was not read,
// and the sheet had the shop's own 3,200 taka.
describe("a price misheard (GearGrid, D178)", () => {
  const part = (style: (typeof STYLES)[number]) =>
    style === "Bangla" ? PARTS[0]!.bangla : PARTS[0]!.banglish;

  it.each(STYLES)("“তিন হাউজার টাকায়” is 3,000 for the line (%s)", async (style) => {
    const shop = shopFor(geargrid);
    const request = said(style, part(style), { bn: "তিন হাউজার টাকায়", en: "tin haujar takay" });
    const reply = await shop.say(fresh(), { text: request.text }, saleCall(request.args));
    expect(reply.confirm?.text).toMatch(/প্রতি সেট ১,৫০০ টাকা, ৩,০০০ টাকা, বাকিতে/);
    expect(line(shop)).toMatchObject({ unit_price_taka: 1500 });
  });

  it.each(STYLES)("“তিন হাউজার টাকাই” and “তিন হাজনার টাকায়” are 3,000 too (%s)", async (style) => {
    for (const price of style === "Bangla"
      ? ["তিন হাউজার টাকাই", "তিন হাজনার টাকায়"]
      : ["tin haujar takai", "tin hajnar takay"]) {
      const shop = shopFor(geargrid);
      const request = said(style, part(style), { bn: price, en: price });
      await shop.say(fresh(), { text: request.text }, saleCall(request.args));
      expect(line(shop)).toMatchObject({ unit_price_taka: 1500 });
    }
  });

  it.each(STYLES)("“হাজার পাঁচশ টাকা” answers the price of one as 1,500 (%s)", async (style) => {
    const shop = shopFor(geargrid);
    const request = said(style, part(style), { bn: "ঝাপসা টাকায়", en: "jhapsa takay" });
    const asked = await shop.say(fresh(), { text: request.text }, saleCall(request.args));
    await shop.say(asked.state, { text: style === "Bangla" ? "হাজার পাঁচশ টাকা" : "hajar pachsho taka" });
    expect(line(shop)).toMatchObject({ unit_price_taka: 1500 });
  });

  it.each(STYLES)("a price whose amount is not read is asked, never left out (%s)", async (style) => {
    const shop = shopFor(geargrid);
    const request = said(style, part(style), { bn: "ঝাপসা টাকায়", en: "jhapsa takay" });
    const asked = await shop.say(fresh(), { text: request.text }, saleCall(request.args));
    expect(asked.reply).toMatch(/প্রতি সেট দাম কত\?$/);
    expect(shop.calls).toHaveLength(0);
    const reply = await shop.say(asked.state, { text: style === "Bangla" ? "১৫০০ টাকা" : "1500 taka" });
    expect(line(shop)).toMatchObject({ quantity: 2, unit_price_taka: 1500 });
    expect(reply.confirm?.text).toMatch(/প্রতি সেট ১,৫০০ টাকা/);
  });

  it.each(STYLES)("staff are refused for it too (%s)", async (style) => {
    const shop = shopFor(geargrid, { role: "staff" });
    const request = said(style, part(style), { bn: "ঝাপসা টাকায়", en: "jhapsa takay" });
    const reply = await shop.say(fresh(), { text: request.text }, saleCall(request.args));
    expect(reply.reply).toBe("অন্য দামে বেচতে পারেন শুধু দোকানের মালিক।");
  });
});

describe("the sale's tool (D176)", () => {
  it("has a place for a price the user sets, apart from the payment", () => {
    const parameters = writeTool(appCapability("record_sale")).function.parameters as {
      properties: { items: { items: { properties: Record<string, unknown> } } };
    };
    expect(Object.keys(parameters.properties.items.items.properties).sort()).toEqual([
      "part",
      "price",
      "quantity",
    ]);
  });
});
