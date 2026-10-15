import { describe, expect, it } from "vitest";
import {
  connect,
  fresh,
  geargrid,
  SALE,
  saleCall,
  shopB,
  ownWords,
  SHOPS,
  tap,
  type Reply,
} from "../../test/sale-apps";
import type { Step } from "../../test/scripted-llm";

// D167: a question answered in a request is never asked again in it, whatever shop app is connected. The owner's
// credit sale of 15 Oct asked the Fielder's year again after every tap. These conversations tap or say each answer, in
// Bangla and in Banglish (D96), over three apps shaped differently (test/sale-apps.ts): GearGrid's two Fielders that
// share 2012, shop B's two Axio chassis of the same years with its own grade words, and an app whose cars have no
// years, with its own engine codes, grades and brands.

describe("the owner's credit sale, the car and its year tapped (GearGrid, D167)", () => {
  it.each(SALE)("taps the Fielder, then 2012–2017: that Fielder's pad, asked once ($style)", async (sale) => {
    const shop = connect(geargrid);
    const first = await shop.say(fresh(), { text: sale.text }, saleCall(sale.args));
    expect(first.asked).toBe("vehicle");
    const fielder = await shop.say(first.state, tap(first, /ফিল্ডার/));
    expect(fielder.reply).toBe("কোন বছরের ফিল্ডার?");
    expect(fielder.choices?.options.map((option) => option.label)).toEqual(["2006–2012", "2012–2017"]);
    const year = await shop.say(fielder.state, tap(fielder, /^2012–2017$/));
    expect(year.asked).toBeUndefined();
    expect(year.confirm?.text).toMatch(/^Rahim Motors — ফিল্ডার ২০১২, সামনের ব্রেক প্যাড, জেনুইন, ২ সেট/);
    expect(shop.sold()).toContain('"pad-new"');
  });

  it.each(SALE)("taps 2006–2012: the quality is asked next, never the year again ($style)", async (sale) => {
    const shop = connect(geargrid);
    const first = await shop.say(fresh(), { text: sale.text }, saleCall(sale.args));
    const fielder = await shop.say(first.state, tap(first, /ফিল্ডার/));
    const year = await shop.say(fielder.state, tap(fielder, /^2006–2012$/));
    expect(year.reply).toBe("জেনুইন না নন-জেনুইন?");
    const quality = await shop.say(year.state, tap(year, /নন-জেনুইন/));
    expect(quality.confirm?.text).toMatch(
      /^Rahim Motors — ফিল্ডার ২০০৬, সামনের ব্রেক প্যাড, নন-জেনুইন, ২ সেট/,
    );
    expect(shop.sold()).toContain('"pad-old-copy"');
  });

  it.each(SALE)(
    "says 2012, which both Fielders have: the next questions are about other things ($style)",
    async (sale) => {
      const shop = connect(geargrid);
      const first = await shop.say(fresh(), { text: sale.text }, saleCall(sale.args));
      const fielder = await shop.say(first.state, tap(first, /ফিল্ডার/));
      const year = await shop.say(fielder.state, { text: sale.said2012 });
      expect(year.asked).toBe("quality");
      const quality = await shop.say(year.state, tap(year, /^জেনুইন/));
      // Two genuine pads, one per Fielder, that read the same: the list says each one's years.
      expect(quality.asked).toBe("part_pick");
      expect(quality.choices?.options.map((option) => option.label)).toEqual([
        "Front brake pad set, Toyota (২০১২–২০১৭)",
        "Front brake pad set, Toyota (২০০৬–২০১২)",
      ]);
      const picked = await shop.say(quality.state, tap(quality, /২০১২–২০১৭/));
      expect(picked.confirm).toBeDefined();
      expect(shop.sold()).toContain('"pad-new"');
    },
  );

  it.each(SALE)("a car changed after its year was tapped asks the new car's year ($style)", async (sale) => {
    const shop = connect(geargrid);
    const first = await shop.say(fresh(), { text: sale.text }, saleCall(sale.args));
    const fielder = await shop.say(first.state, tap(first, /ফিল্ডার/));
    const year = await shop.say(fielder.state, tap(fielder, /^2006–2012$/));
    const axio = await shop.say(year.state, { text: sale.noAxio });
    expect(axio.reply).toBe("কোন বছরের এক্সিও?");
    expect(axio.choices?.options.map((option) => option.label)).toEqual(["2006–2011", "2012–2017"]);
  });
});

describe("other apps' cars, codes and words (D167)", () => {
  it.each(SALE)("shop B: one button for the two Axio chassis of the same years ($style)", async (sale) => {
    const shop = connect(shopB);
    const first = await shop.say(fresh(), { text: sale.text }, saleCall(sale.args));
    // The app's own car names are its buttons (D154): "Axio" is every Axio row.
    const axio = await shop.say(first.state, tap(first, /^Axio$/));
    expect(axio.choices?.options.map((option) => option.label)).toEqual(["2006–2011", "2012–2017"]);
    const year = await shop.say(axio.state, tap(axio, /^2012–2017$/));
    expect(year.asked).toBe("quality");
    const quality = await shop.say(year.state, tap(year, /নন-জেনুইন/));
    expect(quality.confirm).toBeDefined();
    expect(shop.sold()).toContain('"2"');
  });

  it.each(SALE)(
    "cars kept without years: no year button; the app's engine codes pick the part ($style)",
    async (sale) => {
      const shop = connect(ownWords);
      const args = {
        ...sale.args,
        items: [{ ...sale.args.items[0], part: { ...sale.args.items[0].part, vehicle: "pajero" } }],
      };
      const first = await shop.say(fresh(), { text: `${sale.text} pajero` }, saleCall(args));
      expect(first.asked).toBe("engine");
      expect(first.choices?.options.map((option) => option.label)).toEqual(["4D56", "4M40"]);
      const engine = await shop.say(first.state, tap(first, /^4M40$/));
      expect(engine.confirm).toBeDefined();
      expect(shop.sold()).toContain('"pj-4m40"');
    },
  );

  it.each(SALE)(
    "grades and brands no word list knows are picked as the app writes them ($style)",
    async (sale) => {
      const shop = connect(ownWords);
      const args = {
        ...sale.args,
        items: [{ ...sale.args.items[0], part: { ...sale.args.items[0].part, vehicle: "tucson" } }],
      };
      const first = await shop.say(fresh(), { text: `${sale.text} tucson` }, saleCall(args));
      expect(first.asked).toBe("quality");
      const quality = await shop.say(first.state, tap(first, /Silver/i));
      expect(quality.asked).toBe("brand");
      const brand = await shop.say(quality.state, tap(quality, /Zimco/i));
      expect(brand.confirm).toBeDefined();
      expect(shop.sold()).toContain('"tc-silver-zimco"');
    },
  );
});

const ASK = [
  { style: "Bangla", text: "ব্রেক প্যাড আছে?", part: "ব্রেক প্যাড", again: "ফিল্ডারের ব্রেক প্যাড আছে?" },
  { style: "Banglish", text: "brake pad ache?", part: "brake pad", again: "fielder er brake pad ache?" },
] as const;

const findCall = (args: object): Step[] => [{ calls: [{ name: "find_parts", arguments: { ...args } }] }];

describe("a part question, the car and its year tapped (D167)", () => {
  it.each(ASK)(
    "answers for the tapped years, and the same car's next question keeps them ($style)",
    async (ask) => {
      const shop = connect(geargrid);
      const first = await shop.say(fresh(), { text: ask.text }, findCall({ part_type: ask.part }));
      expect(first.asked).toBe("vehicle");
      const fielder = await shop.say(first.state, tap(first, /ফিল্ডার/));
      expect(fielder.choices?.options.map((option) => option.label)).toEqual(["2006–2012", "2012–2017"]);
      const year = await shop.say(fielder.state, tap(fielder, /^2012–2017$/));
      expect(year.asked).toBeUndefined();
      expect(year.found).toEqual(["PAD-NEW"]);
      expect(year.state.context.vehicle).toMatchObject({
        model: "Toyota Fielder",
        years: { from: 2012, to: 2017 },
      });
      // The LLM copies the remembered first year ("ফিল্ডার ২০১২" in its context): the tapped years still hold.
      const again = await shop.say(
        year.state,
        { text: ask.again },
        findCall({ part_type: ask.part, vehicle: "fielder", year: "2012" }),
      );
      expect(again.asked).toBeUndefined();
      expect(again.found).toEqual(["PAD-NEW"]);
    },
  );
});

/**
 * Every button of every question, on every app, for a sale and a part question: after a tap the request goes on, and
 * no question it asked is asked again in it.
 */
describe("no question is asked twice in a request, on any app (D167)", () => {
  async function walk(
    shop: ReturnType<typeof connect>,
    reply: Reply,
    asked: string[],
    paths: { count: number },
  ): Promise<void> {
    if (!reply.asked) {
      paths.count += 1;
      return;
    }
    expect(asked, `${reply.asked} asked again after ${asked.join(", ")}: ${reply.reply}`).not.toContain(
      reply.asked,
    );
    expect(asked.length).toBeLessThan(8);
    for (const option of reply.choices?.options ?? []) {
      const next = await shop.say(reply.state, {
        choice: { slot: reply.choices!.slot, optionId: option.id },
      });
      await walk(shop, next, [...asked, reply.asked], paths);
    }
  }

  for (const app of SHOPS) {
    it.each(SALE)(`${app.name}: a sale, every button ($style)`, async (sale) => {
      const shop = connect(app);
      const paths = { count: 0 };
      await walk(shop, await shop.say(fresh(), { text: sale.text }, saleCall(sale.args)), [], paths);
      expect(paths.count).toBeGreaterThan(1);
    });
    it.each(ASK)(`${app.name}: a part question, every button ($style)`, async (ask) => {
      const shop = connect(app);
      const paths = { count: 0 };
      await walk(
        shop,
        await shop.say(fresh(), { text: ask.text }, findCall({ part_type: ask.part })),
        [],
        paths,
      );
      expect(paths.count).toBeGreaterThan(1);
    });
  }
});
