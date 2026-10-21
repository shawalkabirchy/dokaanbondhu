import { describe, expect, it } from "vitest";
import { connect, fresh, geargrid, ownWords, shopB, type Shop } from "../../test/sale-apps";
import type { Step } from "../../test/scripted-llm";

// The evaluation round's first findings (D186): what the open half of the chat cards showed the assistant get wrong,
// each with the model's own malformed calls from the run, on the three app shapes of D167, in Bangla and Banglish.

const call = (name: string, args: object): Step[] => [{ calls: [{ name, arguments: { ...args } }] }];

/** Each app's part as its own words name it, with the car's model in both scripts. */
const APPS: { app: Shop; bn: object; en: object }[] = [
  {
    app: geargrid,
    bn: { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার", year: "২০১৫" },
    en: { part_type: "brake pad", vehicle: "fielder", year: "2015" },
  },
  {
    app: shopB,
    bn: { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার", year: "২০১৫" },
    en: { part_type: "brake pad", vehicle: "fielder", year: "2015" },
  },
  {
    app: ownWords,
    bn: { part_type: "ব্রেক প্যাড", vehicle: "Tucson", quality: "Platinum" },
    en: { part_type: "brake pad", vehicle: "tucson", quality: "platinum" },
  },
];
const words = (part: object) => Object.values(part).join(" ");

describe("a polite give or write-it-down is no part detail (D186)", () => {
  it.each(APPS)("লিখে দেন / likhe den is never the right side ($app.name)", async ({ app, bn, en }) => {
    for (const [text, args] of [
      [
        `রহিম মোটরসকে ${words(bn)} দুই সেট বাকিতে লিখে দেন`,
        {
          customer: "রহিম মোটরস",
          items: [{ part: bn, quantity: "দুই সেট" }],
          payment: { method_word: "বাকিতে" },
        },
      ],
      [
        `Rahim Motors er name e ${words(en)} dui set bakite likhe den`,
        {
          customer: "Rahim Motors",
          items: [{ part: en, quantity: "dui set" }],
          payment: { method_word: "bakite" },
        },
      ],
    ] as const) {
      const shop = connect(app);
      const sheet = await shop.say(fresh(), { text }, call("record_sale", args));
      expect(sheet.confirm?.text, text).toMatch(/২ সেট/);
      expect(sheet.confirm?.text, text).not.toMatch(/ডান/);
    }
  });
});

describe("a count in pieces of a part sold in sets is that many sets (D186)", () => {
  it.each(APPS)(
    "৩টা / 3ta / tinta of brake pads is 3 sets, asked nothing ($app.name)",
    async ({ app, bn, en }) => {
      for (const [text, args] of [
        [
          `রহিম মোটরসকে ${words(bn)} ৩টা নগদে দেন`,
          {
            customer: "রহিম মোটরস",
            items: [{ part: bn, quantity: "৩টা" }],
            payment: { method_word: "নগদে" },
          },
        ],
        [
          `Rahim Motors ke ${words(en)} tinta nogode den`,
          {
            customer: "Rahim Motors",
            items: [{ part: en, quantity: "tinta" }],
            payment: { method_word: "nogode" },
          },
        ],
        [
          `Rahim Motors ke ${words(en)} 3ta nogode den`,
          {
            customer: "Rahim Motors",
            items: [{ part: en, quantity: "3ta" }],
            payment: { method_word: "nogode" },
          },
        ],
      ] as const) {
        const shop = connect(app);
        const sheet = await shop.say(fresh(), { text }, call("record_sale", args));
        expect(sheet.asked, text).toBeUndefined();
        expect(sheet.confirm?.text, text).toMatch(/৩ সেট/);
      }
    },
  );
});

const twoRahims: Shop = {
  ...geargrid,
  moreCustomers: [{ hostId: "c2", name: "Rahim Auto Garage", nameBn: "রহিম অটো গ্যারেজ", attrs: {} }],
};

describe("a payment's amount said in the request stays after a question (D186)", () => {
  it.each([
    { style: "Bangla", text: "রহিম ১২০০০ টাকা জমা দিল নগদে", name: "রহিম", amount: "১২০০০", method: "নগদে" },
    {
      style: "Banglish",
      text: "rahim 12000 taka dilo cash e",
      name: "rahim",
      amount: "12000",
      method: "nogode",
    },
  ])(
    "asked which Rahim before the payment started, confirms the amount said first ($style)",
    async ({ text, name, amount, method }) => {
      const shop = connect(twoRahims);
      const which = await shop.say(fresh(), { text }, call("resolve_customer", { name }));
      expect(which.reply).toMatch(/Rahim Motors .*Rahim Auto Garage|Rahim Auto Garage .*Rahim Motors/);
      const sheet = await shop.say(
        which.state,
        { text: "Rahim Motors" },
        call("receive_payment", { amount, customer: "Rahim Motors", payment: { method_word: method } }),
      );
      expect(sheet.asked, sheet.reply).toBeUndefined();
      expect(sheet.confirm?.text).toMatch(/১২,০০০ টাকা/);
    },
  );

  it.each([
    { style: "Bangla", text: "১২০০০ টাকা জমা নেন", amount: "১২০০০", answer: "রহিম মোটরস" },
    { style: "Banglish", text: "12000 taka dilo cash e", amount: "12000", answer: "Rahim Motors" },
  ])("asks who paid, then confirms the amount said first ($style)", async ({ text, amount, answer }) => {
    const shop = connect(geargrid);
    const asked = await shop.say(fresh(), { text }, call("receive_payment", { amount }));
    expect(asked.asked).toBe("customer");
    // The model's next call, as in the run, names the customer and leaves the amount out.
    const sheet = await shop.say(
      asked.state,
      { text: answer },
      call("receive_payment", { customer: answer }),
    );
    expect(sheet.asked).toBeUndefined();
    expect(sheet.confirm?.text).toMatch(/১২,০০০ টাকা/);
  });
});

describe("a sale said politely is a sale, even when the model searches the part (D186)", () => {
  it.each(APPS)(
    "…বাকিতে দেন / …name e nogode likhen starts the sale ($app.name)",
    async ({ app, bn, en }) => {
      for (const [text, part] of [
        [`রহিম মোটরসকে ${words(bn)} তিনটা বাকিতে দেন`, bn],
        [`${words(en)} tinta Rahim Motors er name e nogode likhen`, en],
      ] as const) {
        const shop = connect(app);
        const sheet = await shop.say(fresh(), { text }, call("find_parts", part));
        expect(sheet.confirm?.text, `${text}: ${sheet.reply}`).toMatch(/Rahim Motors .*৩ সেট/);
      }
    },
  );

  it.each([
    { style: "Bangla", text: "রহিম মোটরসের ফিল্ডার ২০১৫-এর ব্রেক প্যাডের দামটা বলে দেন", part: APPS[0]!.bn },
    {
      style: "Banglish",
      text: "Rahim Motors er fielder 2015 er brake pad er dam ta bole den",
      part: APPS[0]!.en,
    },
  ])("a question that ends with দেন / den stays a question ($style)", async ({ text, part }) => {
    const shop = connect(geargrid);
    const answer = await shop.say(fresh(), { text }, call("find_parts", part));
    expect(answer.confirm).toBeUndefined();
    expect(answer.reply).toMatch(/টাকা/);
  });
});

describe("goods arriving from a named supplier are a purchase (D186)", () => {
  it.each(APPS)("…থেকে দুইটা এলো / theke duita aslo ($app.name)", async ({ app, bn, en }) => {
    for (const [text, part] of [
      [`নবাবপুর অটো পার্টস থেকে ${words(bn)} দুই সেট এলো, প্রতি সেট ১২০০ টাকা`, bn],
      [`Nawabpur Auto Parts theke ${words(en)} dui set aslo, proti set 1200 taka`, en],
    ] as const) {
      const shop = connect(app);
      const asked = await shop.say(fresh(), { text }, call("find_parts", part));
      // The request does not say how it is paid: asked, as for any purchase.
      expect(asked.asked, `${text}: ${asked.reply}`).toBe("payment");
      const sheet = await shop.say(asked.state, { text: text.includes("theke") ? "bakite" : "বাকিতে" });
      expect(sheet.confirm?.text, `${text}: ${sheet.reply}`).toMatch(/Nawabpur Auto Parts/);
      expect(sheet.confirm?.text).toMatch(/২ সেট/);
    }
  });

  it.each(APPS)(
    "the same part twice in the model's call is one line ($app.name)",
    async ({ app, bn, en }) => {
      for (const [text, part, quantity] of [
        [`নবাবপুর অটো পার্টস থেকে ${words(bn)} দুই সেট এলো, প্রতি সেট ১২০০ টাকা`, bn, "দুই সেট"],
        [`Nawabpur Auto Parts theke ${words(en)} dui set aslo, proti set 1200 taka`, en, "dui set"],
      ] as const) {
        const shop = connect(app);
        const line = { part, quantity, unit_cost: "1200" };
        const asked = await shop.say(
          fresh(),
          { text },
          call("stock_in", { supplier: "Nawabpur Auto Parts", items: [line, line] }),
        );
        expect(asked.reply, text).not.toMatch(/একবারে একটা/);
        const sheet = await shop.say(asked.state, { text: text.includes("theke") ? "bakite" : "বাকিতে" });
        expect(sheet.confirm?.text, `${text}: ${sheet.reply}`).toMatch(/২ সেট/);
      }
    },
  );
});

describe("a return finds its part from what the buyer bought (D186)", () => {
  const PART: Record<string, string> = {
    GearGrid: "pad-new",
    "shop B": "2",
    "an app with its own words": "tc-platinum",
  };
  it.each(APPS)(
    "…কালকের সামনের প্যাড ফেরত / …kalker samner pad ferot, no car asked ($app.name)",
    async ({ app }) => {
      const sales = [
        {
          id: "sale-1",
          lineId: "line-1",
          partId: PART[app.name]!,
          customerId: "c1",
          quantity: 1,
          unitPrice: 1600,
          due: 1600,
          daysAgo: 1,
        },
      ];
      for (const [text, args] of [
        [
          "রহিম মোটরস কালকের সামনের প্যাডটা ফেরত দিয়েছে, ভাঙা ছিল",
          {
            customer: "রহিম মোটরস",
            items: [{ part: { part_type: "ব্রেক প্যাড", position: "সামনের" }, quantity: "১" }],
            when: "গতকাল",
          },
        ],
        [
          "Rahim Motors kalker samner pad ta ferot dise, vanga chilo",
          {
            customer: "Rahim Motors",
            items: [{ part: { part_type: "Brake Pad", position: "front" }, quantity: "1" }],
            when: "kalke",
          },
        ],
      ] as const) {
        const shop = connect({ ...app, sales, customerDue: 19200 });
        const sheet = await shop.say(fresh(), { text }, call("record_return", args));
        expect(sheet.asked, `${text}: ${sheet.reply}`).toBeUndefined();
        expect(sheet.confirm?.text).toMatch(/^Rahim Motors — গতকালের .*১ সেট, ১,৬০০ টাকা ফেরত/);
      }
    },
  );

  it("two of the buyer's buys fit: the part is asked as for a sale", async () => {
    const sales = [
      {
        id: "s1",
        lineId: "l1",
        partId: "pad-old",
        customerId: "c1",
        quantity: 1,
        unitPrice: 1600,
        due: 0,
        daysAgo: 2,
      },
      {
        id: "s2",
        lineId: "l2",
        partId: "pad-new",
        customerId: "c1",
        quantity: 1,
        unitPrice: 1600,
        due: 0,
        daysAgo: 1,
      },
    ];
    const shop = connect({ ...geargrid, sales, customerDue: 19200 });
    const asked = await shop.say(
      fresh(),
      { text: "Rahim Motors brake pad ferot dise" },
      call("record_return", {
        customer: "Rahim Motors",
        items: [{ part: { part_type: "brake pad" }, quantity: "1" }],
      }),
    );
    expect(asked.asked).toBeDefined();
    expect(asked.confirm).toBeUndefined();
  });
});

describe("a part asked by its number is named, with the cars it fits (D186)", () => {
  it.each([
    { style: "Bangla", text: "PAD-NEW কোন গাড়ির মাল?" },
    { style: "Banglish", text: "PAD-NEW kon kon garite lage?" },
  ])("PAD-NEW: its name, stock, price, rack and cars ($style)", async ({ text }) => {
    const shop = connect(geargrid, { evalMode: true });
    const answer = await shop.say(fresh(), { text }, [
      { calls: [{ name: "find_parts", arguments: { part_number: "PAD-NEW" } }] },
      { text: "" },
    ]);
    expect(answer.reply).toMatch(/^PAD-NEW \(.+\) .+ আছে, .*টাকা/);
    expect(answer.reply).toMatch(/লাগে: এক্সিও .*ফিল্ডার .*প্রিমিও /);
    expect(answer.reply).not.toMatch(/^-এর/);
    expect(answer.trace.lookups.at(-1)?.cars).toEqual([
      "toyota-axio-2012",
      "toyota-fielder-2012",
      "toyota-premio-2012",
    ]);
  });
});

describe("the model's call is read for what the user said, nothing more (D186)", () => {
  it.each(APPS)(
    "a part type beside the part, a made-up part number, and ekta / একটা left out ($app.name)",
    async ({ app, bn, en }) => {
      for (const [text, part, word] of [
        [`রহিম মোটরসের নামে একটা ${words(bn)} বাকিতে লিখে দেন`, bn, "বাকিতে"],
        [`Rahim Motors er name e ekta ${words(en)} bakite likhen`, en, "bakite"],
      ] as const) {
        const { part_type, ...rest } = part as Record<string, string>;
        const shop = connect(app);
        const sheet = await shop.say(
          fresh(),
          { text },
          call("record_sale", {
            customer: "Rahim Motors",
            items: [{ part: { ...rest, part_number: "unknown" }, part_type }],
            payment: { method_word: word },
          }),
        );
        expect(sheet.asked, `${text}: ${sheet.reply}`).toBeUndefined();
        expect(sheet.confirm?.text).toMatch(/১ সেট/);
      }
    },
  );

  it.each([
    {
      style: "Bangla",
      text: "রহিম মোটরসকে ফিল্ডার ২০১০-এর ব্রেক প্যাড দুই সেট বাকিতে দাও",
      part: { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার", year: "২০১০" },
    },
    {
      style: "Banglish",
      text: "Rahim Motors ke fielder 2010 er brake pad dui set bakite dao",
      part: { part_type: "brake pad", vehicle: "fielder", year: "2010" },
    },
  ])("a quality nobody said is asked, never chosen for the user ($style)", async ({ text, part }) => {
    const shop = connect(geargrid);
    const asked = await shop.say(
      fresh(),
      { text },
      call("record_sale", {
        customer: "Rahim Motors",
        items: [{ part: { ...part, quality: "genuine" }, quantity: "2 set" }],
        payment: { method_word: "bakite" },
      }),
    );
    expect(asked.asked).toBe("quality");
  });
});

describe("the read query tool says how its database writes days (D186)", () => {
  it("PostgreSQL in Dhaka time for GearGrid's map, MySQL for shop B's", async () => {
    const { readQueryTool } = await import("./tools");
    const { geargridMap } = await import("../../test/geargrid-map");
    const { shopBMap } = await import("../../test/shop-b-map");
    expect(readQueryTool(geargridMap).function.description).toMatch(/PostgreSQL.*AT TIME ZONE 'Asia\/Dhaka'/);
    expect(readQueryTool(shopBMap).function.description).toMatch(/MySQL.*CURDATE\(\) - INTERVAL 1 DAY/);
  });
});
