import { describe, expect, it } from "vitest";
import {
  connect,
  fresh,
  geargrid,
  ownWords,
  shopB,
  tap,
  type Shop,
  type ShopSale,
} from "../../test/sale-apps";
import type { Step } from "../../test/scripted-llm";

// The weak spots the final evaluation's held-out half showed (D257), fixed as product improvements: the evaluation's
// own score stays as it was (D256). Each case as the run had it, on the three app shapes of D167, in Bangla and in
// Banglish (D96).

const call = (name: string, args: object): Step[] => [{ calls: [{ name, arguments: { ...args } }] }];
const APPS = [geargrid, shopB, ownWords];

/** Each app's part that carries a part number, and its second car said with "also". */
const NUMBERED: Record<string, { part: string; also: [string, string]; car: [string, string] }> = {
  GearGrid: {
    part: "pad-old-copy",
    also: ["ফিল্ডারেও", "fielder eo"],
    car: ["ফিল্ডার ২০১৫", "fielder 2015"],
  },
  "shop B": { part: "2", also: ["ফিল্ডারেও", "fielder eo"], car: ["ফিল্ডার ২০১৫", "fielder 2015"] },
  "an app with its own words": {
    part: "pj-4d56",
    also: ["Tucson এও", "tucson eo"],
    car: ["Tucson ২০১৮", "tucson 2018"],
  },
};
const numbered = (app: Shop): Shop => ({
  ...app,
  parts: app.parts.map((part) =>
    part.id === NUMBERED[app.name]!.part ? { ...part, numbers: ["04465-12592"] } : part,
  ),
});

describe("goods received said as staff say it: “mal uthan” (c-128, c-156, c-160)", () => {
  /** Each app's part said with its car and year. */
  const SAID: Record<string, [string, string]> = {
    GearGrid: ["ফিল্ডার ২০১৫ এর জেনুইন সামনের ব্রেক প্যাড", "fielder 2015 er genuine samner brake pad"],
    "shop B": ["ফিল্ডার ২০১৫ এর সামনের ব্রেক প্যাড", "fielder 2015 er samner brake pad"],
    "an app with its own words": ["Tucson ২০১৮ এর Platinum ব্রেক প্যাড", "tucson 2018 er platinum brake pad"],
  };
  for (const app of APPS) {
    it.each([
      { style: "Bangla", text: `দুইটা ${SAID[app.name]![0]} মাল উঠান ৩৫০০ করে` },
      { style: "Banglish", text: `duita ${SAID[app.name]![1]} mal uthan 3500 kore` },
    ])(`is stock coming in, though the model called a sale (${app.name}, $style)`, async ({ text }) => {
      const shop = connect(app);
      // The model's call in the run: a sale, which then wanted a customer for credit.
      const reply = await shop.say(fresh(), { text }, [
        ...call("record_sale", {
          items: [{ part: { part_type: "brake pad" }, quantity: "2", price: "3500" }],
        }),
        { text: "" },
      ]);
      expect(reply.trace.tool_calls[0]?.result, reply.reply).toBe("write: stock_in");
      expect(reply.reply).not.toMatch(/কাস্টমার/);
    });
  }
});

describe("a fitment said with “write it down”, the model moving a rack (v-163)", () => {
  for (const app of APPS.map(numbered)) {
    const { also } = NUMBERED[app.name]!;
    it.each([
      { style: "Bangla", text: `লিখে রাখো 04465-12592 পার্টটা ${also[0]} লাগে` },
      { style: "Banglish", text: `likhe rakho 04465 12592 part ta ${also[1]} lage` },
    ])(`starts the fitment, never a rack change (${app.name}, $style)`, async ({ text }) => {
      const shop = connect(app);
      // The model's call in the run: the part number's last letters taken for rack K-10.
      const reply = await shop.say(fresh(), { text }, [
        ...call("update_rack", { part: { part_number: "0446512592" }, rack: "K-10" }),
        { text: "" },
      ]);
      expect(reply.trace.tool_calls[0]?.result, reply.reply).toBe("write: add_fitment");
      expect(`${reply.reply} ${reply.confirm?.text ?? ""}`).not.toMatch(/রাখা হবে|K-10/);
    });
  }
});

describe("a fitment said with the part's number, the model searching (v-135)", () => {
  for (const app of APPS.map(numbered)) {
    const { also } = NUMBERED[app.name]!;
    it.each([
      // as the clean-up had it in the run: the "also" cut from the car ("নোয়াতেও" made "নোয়া")
      { style: "Bangla", text: `04465-12592 পার্টটা ${also[0]} লাগে`, cut: also[0].replace(/এও$|েও$/u, "ে") },
      { style: "Banglish", text: `04465 12592 part ta ${also[1]} lage`, cut: null },
    ])(`starts the fitment from the words (${app.name}, $style)`, async ({ text, cut }) => {
      const cleanup = cut ? JSON.stringify({ replaced: [{ heard: also[0], meant: cut }] }) : undefined;
      const shop = connect(app, cleanup ? { cleanups: [cleanup] } : {});
      const reply = await shop.say(fresh(), { text }, [
        ...call("find_parts", { part_type: "04465-12592", vehicle: "Fielder" }),
        { text: "" },
      ]);
      expect(reply.trace.tool_calls[0]?.result, reply.reply).toBe("write: add_fitment");
    });
  }
});

describe("whether a part fits, asked, the model offering to add it (v-194)", () => {
  for (const app of APPS.map(numbered)) {
    const { car } = NUMBERED[app.name]!;
    it.each([
      { style: "Bangla", text: `04465-12592 পার্টটা ${car[0]} এ লাগবে` },
      { style: "Banglish", text: `04465 12592 part ta ${car[1]} e lagbe` },
    ])(`is answered, and nothing is offered to add (${app.name}, $style)`, async ({ text }) => {
      const shop = connect(app);
      const [model, year] = car[1].split(" ");
      const reply = await shop.say(fresh(), { text }, [
        ...call("add_fitment", { part: { part_number: "0446512592" }, vehicle: { model, year } }),
        { text: "" },
      ]);
      expect(reply.confirm, reply.reply).toBeUndefined();
      expect(reply.state.action ?? null).toBeNull();
      expect(reply.reply).not.toMatch(/যোগ করব/);
      expect(reply.trace.tool_calls[0]?.result).toMatch(/^fit question/);
    });
  }
});

describe("a return said of “the” part, its sale of two sets (v-149, v-164)", () => {
  const PART: Record<string, string> = {
    GearGrid: "pad-new",
    "shop B": "2",
    "an app with its own words": "tc-platinum",
  };
  const TO_ONE_PART: Record<string, RegExp[]> = {
    GearGrid: [/ফিল্ডার/, /^2012–2017$/],
    "shop B": [/^Axio$/, /^2012–2017$/, /নন-জেনুইন/],
    "an app with its own words": [/Tucson/i, /Platinum/i],
  };
  const sale = (partId: string): ShopSale => ({
    id: "sale-1",
    lineId: "line-1",
    partId,
    customerId: "c1",
    quantity: 2,
    unitPrice: 1600,
    due: 3200,
    daysAgo: 3,
  });
  for (const app of APPS) {
    it.each([
      { style: "Bangla", text: "রহিম মোটরস সামনের ব্রেক প্যাডটা ফেরত দিয়েছে", part: "ব্রেক প্যাড" },
      { style: "Banglish", text: "Rohim Motors samner brake pad ta ferot dise", part: "brake pad" },
    ])(`is one set, shown on the sheet, never asked (${app.name}, $style)`, async ({ text, part }) => {
      const shop = connect({ ...app, sales: [sale(PART[app.name]!)], customerDue: 19200 });
      let reply = await shop.say(
        fresh(),
        { text },
        call("record_return", {
          customer: text.split(" ").slice(0, 2).join(" "),
          items: [{ part: { part_type: part } }],
        }),
      );
      for (const label of TO_ONE_PART[app.name]!) {
        if (!reply.choices?.options.some((option) => label.test(option.label))) break;
        reply = await shop.say(reply.state, tap(reply, label));
      }
      expect(reply.asked, reply.reply).toBeUndefined();
      expect(reply.confirm?.text).toMatch(/১ সেট, ১,৬০০ টাকা ফেরত/);
    });
  }
});

describe("reminders asked other ways (c-103, c-210, v-084)", () => {
  for (const app of APPS) {
    // The first part empty, the second low (1 against 2), the rest at 4.
    const stocked: Shop = {
      ...app,
      stock: { [app.parts[0]!.id]: 0, [app.parts[1]!.id]: 1 },
      reorder: Object.fromEntries(app.parts.map((part) => [part.id, 2])),
    };
    it.each([
      { style: "Bangla", text: "কোন কোন মাল শেষের দিকে?" },
      { style: "Banglish", text: "kon kon mal shesher dike?" },
    ])(`“almost out” is the low list, at once (${app.name}, $style)`, async ({ text }) => {
      const reply = await connect(stocked).say(fresh(), { text });
      expect(reply.reply).toMatch(/^২টি পার্ট কম আছে/);
      expect(reply.trace.llm_calls).toBe(0);
    });
    it.each([
      { style: "Bangla", text: "কোন মাল একদম শেষ?" },
      { style: "Banglish", text: "kon mal ekdom shesh?" },
    ])(`“none left” lists only the empty parts (${app.name}, $style)`, async ({ text }) => {
      const reply = await connect(stocked).say(fresh(), { text });
      expect(reply.reply).toMatch(/^১টি পার্ট একদম শেষ/);
      expect(reply.tables[0]?.title).toBe("স্টক শেষ");
      expect(reply.tables[0]?.rows).toHaveLength(1);
    });
    it.each([
      { style: "Bangla", text: "পুরনো বাকি কার কার?", heard: "কার", meant: "করিম অটো" },
      { style: "Banglish", text: "purono baki kar kar?", heard: "kar", meant: "Karim Auto" },
    ])(
      `“whose old dues” names no customer, a Karim beside it (${app.name}, $style)`,
      async ({ text, heard, meant }) => {
        // The clean-up's answer in the run: "kar" as Karim Auto.
        const cleanup = JSON.stringify({ replaced: [{ heard, meant }] });
        const shop = connect(
          {
            ...app,
            customerDue: 5000,
            moreCustomers: [{ hostId: "c3", name: "Karim Auto", nameBn: "করিম অটো", attrs: {} }],
            sales: [
              {
                id: "s1",
                lineId: "s1-line",
                partId: app.parts[0]!.id,
                customerId: "c1",
                quantity: 1,
                unitPrice: 3000,
                due: 3000,
                daysAgo: 45,
              },
            ],
          },
          { cleanups: [cleanup] },
        );
        const reply = await shop.say(fresh(), { text }, [
          // the model's calls in the run: Karim Auto's own due
          ...call("resolve_customer", { name: "Karim Auto" }),
          { text: "" },
        ]);
        expect(reply.reply).toMatch(/জনের বাকি ৩০ দিনের বেশি পুরোনো/);
        expect(reply.trace.cleanup ?? []).toEqual([]);
      },
    );
  }
});

/** The test shop's rack labels, so the ones said are among many as in the run. */
const LABELS = ["A-1", "A-2", "B-1", "B-2", "B-3", "C-1", "C-2", "F-1", "F-2", "G-3", "G-4", "K-1"];

describe("a rack change said with Whisper's “রেক”, the model adding a relay (v-206)", () => {
  for (const app of APPS.map(numbered)) {
    const part = NUMBERED[app.name]!.part;
    const shop0: Shop = { ...app, catalogRacks: { [part]: LABELS } };
    it.each([
      { style: "Bangla", text: "04465-12592 পার্টটা বি থ্রি থেকে সরিয়ে এফ টু রেক এ রাখো" },
      { style: "Banglish", text: "04465 12592 part ta B 3 theke soriye F 2 rack e rakho" },
    ])(
      `moves the numbered part, and “সরিয়ে” is no misheard name (${app.name}, $style)`,
      async ({ text }) => {
        const shop = connect(shop0, {
          cleanups: [JSON.stringify({ replaced: [{ heard: "সরিয়ে", meant: "রিলে" }] })],
        });
        const reply = await shop.say(fresh(), { text }, [
          ...call("update_rack", { part: { part_number: "0446512592", part_type: "Relay" }, rack: "F-2" }),
          { text: "" },
        ]);
        expect(reply.confirm?.text, reply.reply).toMatch(/F-2/);
        expect(JSON.stringify(reply.state.action?.request)).toContain(part);
        expect(JSON.stringify(reply.cleanups)).not.toMatch(/সরিয়ে/);
      },
    );
  }
});

describe("one part number on two parts, the rack it is on now said (c-206)", () => {
  /** Each app's two parts that share a number, on B-2 and C-1. */
  const TWO: Record<string, [string, string]> = {
    GearGrid: ["pad-new", "pad-old"],
    "shop B": ["1", "2"],
    "an app with its own words": ["tc-platinum", "tc-silver-rexo"],
  };
  for (const app of APPS) {
    const [onB2, onC1] = TWO[app.name]!;
    const shared: Shop = {
      ...app,
      parts: app.parts.map((part) =>
        part.id === onB2 || part.id === onC1 ? { ...part, numbers: ["04465-10047"] } : part,
      ),
      racks: { [onB2]: ["B-2"], [onC1]: ["C-1"] },
      catalogRacks: { [onB2]: LABELS },
    };
    it.each([
      { style: "Bangla", text: "04465-10047 পার্টটা B-2 থেকে সরিয়ে G-4 এ রাখেন" },
      { style: "Banglish", text: "04465-10047 part ta B-2 theke soriye G-4 e rakhen" },
    ])(`the rack said picks the part, nothing asked (${app.name}, $style)`, async ({ text }) => {
      const shop = connect(shared);
      const reply = await shop.say(fresh(), { text }, [
        ...call("update_rack", { part: { part_number: "04465-10047" }, rack: "G-4" }),
        { text: "" },
      ]);
      expect(reply.asked, reply.reply).toBeUndefined();
      expect(reply.confirm?.text).toMatch(/G-4/);
      expect(JSON.stringify(reply.state.action?.request)).toContain(onB2);
    });
  }
});

describe("a write's year none of the car's parts fits, as speech heard 2016 for 2026 (v-148)", () => {
  const SAID: Record<string, { bangla: string; banglish: string; model: string; answer: string }> = {
    GearGrid: {
      bangla: "ফিল্ডারের দুই হাজার ছাব্বিশের",
      banglish: "fielder 2026 er",
      model: "Fielder",
      answer: "২০১৫",
    },
    "shop B": {
      bangla: "ফিল্ডারের দুই হাজার ছাব্বিশের",
      banglish: "fielder 2026 er",
      model: "Fielder",
      answer: "২০১৫",
    },
    "an app with its own words": {
      bangla: "Tucson দুই হাজার ছাব্বিশের",
      banglish: "tucson 2026 er",
      model: "Tucson",
      answer: "২০১৮",
    },
  };
  for (const app of APPS) {
    const said = SAID[app.name]!;
    it.each([
      {
        style: "Bangla",
        text: `নবাবপুর অটো পার্টস থেকে দুইটা ${said.bangla} সামনের ব্রেক প্যাড আসছে প্রতিটা ১৫০০ টাকা`,
      },
      {
        style: "Banglish",
        text: `nawabpur auto parts theke duita ${said.banglish} samner brake pad asche proti ta 1500 taka`,
      },
    ])(`asks the year once more, never “not found” (${app.name}, $style)`, async ({ text }) => {
      const shop = connect(app);
      const first = await shop.say(fresh(), { text }, [
        ...call("stock_in", {
          supplier: "Nawabpur Auto Parts",
          items: [
            {
              part: { part_type: "brake pad", position: "front", vehicle: said.model, year: "2026" },
              quantity: "2",
              unit_cost: "1500",
            },
          ],
        }),
        { text: "" },
      ]);
      expect(first.asked, first.reply).toBe("year");
      expect(first.reply).not.toMatch(/পাওয়া যায়নি/);
      const next = await shop.say(first.state, { text: said.answer });
      expect(next.asked, next.reply).not.toBe("year");
    });
  }
});

describe("a brand said by its exact name, the model leaving it out (c-062)", () => {
  /** Each app's search, and the brand of one of its parts said in it. */
  const SAID: Record<string, { bangla: string; banglish: string; part: object; brand: string }> = {
    GearGrid: {
      bangla: "ফিল্ডার ২০০৮ এ Akebono ব্রেক প্যাড লাগবে",
      banglish: "fielder 2008 e akebono brake pad lagbe",
      part: { part_type: "brake pad", vehicle: "Fielder", year: "2008" },
      brand: "Akebono",
    },
    "shop B": {
      bangla: "ফিল্ডার ২০১৫ এ Akebono ব্রেক প্যাড লাগবে",
      banglish: "fielder 2015 e akebono brake pad lagbe",
      part: { part_type: "brake pad", vehicle: "Fielder", year: "2015" },
      brand: "Akebono",
    },
    "an app with its own words": {
      bangla: "Tucson ২০১৮ এ Zimco ব্রেক প্যাড লাগবে",
      banglish: "tucson 2018 e zimco brake pad lagbe",
      part: { part_type: "brake pad", vehicle: "Tucson", year: "2018" },
      brand: "Zimco",
    },
  };
  const withAkebono = (app: Shop): Shop =>
    app.name === "shop B"
      ? { ...app, parts: app.parts.map((part) => (part.id === "1" ? { ...part, brand: "Akebono" } : part)) }
      : app;
  for (const app of APPS.map(withAkebono)) {
    const said = SAID[app.name]!;
    it.each([
      { style: "Bangla", text: said.bangla },
      { style: "Banglish", text: said.banglish },
    ])(`completes the search (${app.name}, $style)`, async ({ text }) => {
      const reply = await connect(app).say(fresh(), { text }, [
        ...call("find_parts", said.part),
        { text: "" },
      ]);
      expect(reply.trace.lookups[0]?.resolved.brand, reply.reply).toBe(said.brand);
    });
  }

  it.each([
    { style: "Bangla", text: "টয়োটা ফিল্ডার ২০০৮ এর ব্রেক প্যাড আছে" },
    { style: "Banglish", text: "toyota fielder 2008 er brake pad ache" },
  ])("a make said with its car is no brand (GearGrid, $style)", async ({ text }) => {
    const reply = await connect(geargrid).say(fresh(), { text }, [
      ...call("find_parts", { part_type: "brake pad", vehicle: "Toyota Fielder", year: "2008" }),
      { text: "" },
    ]);
    expect(reply.trace.lookups[0]?.resolved.brand ?? null).toBeNull();
  });
});

// The fixes checked on the 16 clips once more (D257): stock coming in with its supplier not known, its count, and the
// clean-up's answers in that run.

/** Each app's part said with its car and year, for stock coming in and a sale. */
const PART_SAID: Record<string, { bangla: string; banglish: string; part: object }> = {
  GearGrid: {
    bangla: "ফিল্ডার ২০১৫ এর ব্রেক প্যাড",
    banglish: "fielder 2015 er brake pad",
    part: { part_type: "brake pad", vehicle: "Fielder", year: "2015" },
  },
  "shop B": {
    bangla: "ফিল্ডার ২০১৫ এর ব্রেক প্যাড",
    banglish: "fielder 2015 er brake pad",
    part: { part_type: "brake pad", vehicle: "Fielder", year: "2015" },
  },
  "an app with its own words": {
    bangla: "Tucson ২০১৮ এর Platinum ব্রেক প্যাড",
    banglish: "tucson 2018 er platinum brake pad",
    part: { part_type: "brake pad", vehicle: "Tucson", year: "2018", quality: "Platinum" },
  },
};

/** Answers each question the write asks, as the card would, until the sheet or a question it has no answer for. */
async function toSheet(
  shop: ReturnType<typeof connect>,
  first: Awaited<ReturnType<ReturnType<typeof connect>["say"]>>,
  answers: Record<string, string>,
) {
  let reply = first;
  for (let step = 0; step < 5 && reply.asked && answers[reply.asked]; step += 1)
    reply = await shop.say(reply.state, { text: answers[reply.asked]! }, [{ text: "" }]);
  return reply;
}

describe("stock coming in, the supplier not known (c-128, c-156, c-160)", () => {
  for (const app of APPS) {
    const said = PART_SAID[app.name]!;
    it.each([
      { style: "Bangla", text: `দুইটা ${said.bangla} মাল উঠান ৪০০ করে`, dontKnow: "জানি না" },
      { style: "Banglish", text: `duita ${said.banglish} mal uthan 400 kore`, dontKnow: "jani na" },
    ])(
      `“don't know” is told the supplier is needed, and asked again (${app.name}, $style)`,
      async ({ text, dontKnow }) => {
        const shop = connect(app);
        const first = await shop.say(fresh(), { text }, [
          ...call("stock_in", { items: [{ part: said.part, quantity: "2", unit_cost: "400" }] }),
          { text: "" },
        ]);
        const asked = await toSheet(shop, first, { unit_cost: "400" });
        expect(asked.asked, asked.reply).toBe("supplier");
        const reply = await shop.say(asked.state, { text: dontKnow }, [{ text: "" }]);
        expect(reply.reply).toBe(
          "কার কাছ থেকে মাল এসেছে, সেটা ছাড়া স্টকে তোলা যায় না। সাপ্লায়ারের নাম বলুন।",
        );
        expect(reply.asked).toBe("supplier");
        expect(reply.trace.llm_calls).toBe(0);
      },
    );

    it.each([
      { style: "Bangla", text: `নবাবপুর অটো পার্টস থেকে দশটা ${said.bangla} মাল উঠান ৪০০ করে`, cash: "নগদ" },
      {
        style: "Banglish",
        text: `nawabpur auto parts theke doshta ${said.banglish} mal uthan 400 kore`,
        cash: "nogod",
      },
    ])(
      `the count said, never the price the model put in as it (${app.name}, $style)`,
      async ({ text, cash }) => {
        const shop = connect(app);
        // The model's call in the run: the price as the count.
        const first = await shop.say(fresh(), { text }, [
          ...call("stock_in", {
            supplier: "Nawabpur Auto Parts",
            items: [{ part: said.part, quantity: "400", unit_cost: "400" }],
          }),
          { text: "" },
        ]);
        const reply = await toSheet(shop, first, {
          unit_cost: "400",
          payment: cash,
          supplier: "Nawabpur Auto Parts",
        });
        expect(reply.confirm?.text, reply.reply).toMatch(/১০ সেট|১০টা/);
        expect(reply.confirm?.text).not.toMatch(/৪০০ সেট|৪০০টা/);
      },
    );
  }
});

describe("the clean-up's answers in the 16 clips' run, never taken (v-169, c-103)", () => {
  for (const app of APPS) {
    const said = PART_SAID[app.name]!;
    it.each([
      {
        style: "Bangla",
        text: `রহিম মোটরসকে দুইটা ${said.bangla} প্রত্যেকটা দুঃশ পঞ্চাশ টাকার দামে বাকিতে দাও`,
        heard: "দুঃশ",
      },
      {
        style: "Banglish",
        text: `rahim motors ke duita ${said.banglish} prottekta duisho ponchash takar dame bakite dao`,
        heard: "duisho",
      },
    ])(`two hundred is no “bush” (${app.name}, $style)`, async ({ text, heard }) => {
      const shop = connect(app, { cleanups: [JSON.stringify({ replaced: [{ heard, meant: "বুশ" }] })] });
      const reply = await shop.say(fresh(), { text }, [
        ...call("record_sale", {
          customer: "Rahim Motors",
          items: [{ part: said.part, quantity: "2", price: "250" }],
          payment: "due",
        }),
        { text: "" },
      ]);
      expect(reply.trace.cleanup ?? [], reply.reply).toEqual([]);
      expect(JSON.stringify(reply.cleanups)).not.toContain(heard);
    });
  }

  for (const app of APPS) {
    const stocked: Shop = {
      ...app,
      stock: { [app.parts[0]!.id]: 0, [app.parts[1]!.id]: 1 },
      reorder: Object.fromEntries(app.parts.map((part) => [part.id, 2])),
    };
    it.each([
      { style: "Bangla", text: "কোন কোন মাল শেষের দিকে?", heard: "শেষের", meant: "সাইলেন্সার" },
      { style: "Banglish", text: "kon kon mal shesher dike?", heard: "shesher", meant: "Silencer" },
    ])(`“almost out” is no silencer (${app.name}, $style)`, async ({ text, heard, meant }) => {
      const shop = connect(stocked, { cleanups: [JSON.stringify({ replaced: [{ heard, meant }] })] });
      const reply = await shop.say(fresh(), { text }, [{ text: "" }]);
      expect(reply.reply).toMatch(/^২টি পার্ট কম আছে/);
      expect(reply.trace.cleanup ?? []).toEqual([]);
    });
  }
});

describe("a sale's price said “… টাকার দামে”, the model's price nobody said (v-169)", () => {
  for (const app of APPS) {
    const said = PART_SAID[app.name]!;
    it.each([
      {
        style: "Bangla",
        text: `রহিম মোটরসকে দুইটা ${said.bangla} প্রত্যেকটা দুঃশ পঞ্চাশ টাকার দামে বাকিতে বিক্রি করং`,
      },
      {
        style: "Banglish",
        text: `rahim motors ke duita ${said.banglish} prottekta duisho ponchash takar dame bakite bikri koro`,
      },
    ])(`is 250 each on the sheet (${app.name}, $style)`, async ({ text }) => {
      const shop = connect(app, { role: "owner" });
      // The model's call in the run: a price of 2050 nobody said.
      const reply = await shop.say(fresh(), { text }, [
        ...call("record_sale", {
          customer: "Rahim Motors",
          items: [{ part: said.part, quantity: "2", price: "2050" }],
          payment: "due",
        }),
        { text: "" },
      ]);
      expect(reply.confirm, reply.reply).toBeDefined();
      const body = shop.calls.at(-1)?.body as { items: Record<string, unknown>[] };
      expect(body.items[0]).toMatchObject({ quantity: 2, unit_price_taka: 250 });
    });
  }
});
