import { describe, expect, it } from "vitest";
import {
  connect,
  fresh,
  geargrid,
  ownWords,
  shopB,
  tap,
  type ApiAnswer,
  type Shop,
} from "../../test/sale-apps";
import type { Step } from "../../test/scripted-llm";

// S1 and S2's run, the shop's staff (D252): a car from the speech model's other guesses beside a part number said
// aloud; the shop's own codes said as words ("লক এয়ার", LOC-AIR) and a number heard close to two; staff asking the
// assistant to change a price ("করতে বলুন"); a customer's name with its first word lost ("ঢাকা গ্যারেজ"). On the three
// app shapes of D167, in Bangla and in Banglish (D96).

const call = (name: string, args: object): Step[] => [{ calls: [{ name, arguments: { ...args } }] }];
const APPS_OF = (make: (app: Shop) => Shop) => [geargrid, shopB, ownWords].map(make);

/** Each app's two pads, one under 04465-10010, the other under two of the shop's own codes a sound apart. */
const PADS: Record<string, [string, string]> = {
  GearGrid: ["pad-new", "pad-old"],
  "shop B": ["1", "2"],
  "an app with its own words": ["tc-platinum", "tc-silver-rexo"],
};
const coded = (app: Shop): Shop => {
  const [first, second] = PADS[app.name]!;
  return {
    ...app,
    parts: app.parts.map((part) =>
      part.id === first
        ? { ...part, numbers: ["04465-10010", "LOC-AIR-1179"] }
        : part.id === second
          ? { ...part, numbers: ["LOC-AIR-1171"] }
          : part,
    ),
  };
};

describe("the transcript is the first guess, whatever the speech model's list puts first (v-091)", () => {
  const SAID = [
    {
      style: "Bangla",
      text: "জিরো ফোর ফোর সিক্স ফাইভ ওয়ান জিরো জিরো ওয়ান জিরো নম্বরের প্যাড কোন কোন গাড়িতে লাগে",
      // the list's first guess in the run wrote ফাইট (fight) for the number's ফাইভ, a Honda Fit nobody said
      other: "জিরো ফোর ফোর সিক্স ফাইট ওয়ান জিরো জিরো ওয়ান জিরো নম্বরের প্যাড কোন কোন গাড়িতে লাগে",
    },
    {
      style: "Banglish",
      text: "zero four four six five one zero zero one zero number er pad kon kon gari te lage",
      other: "zero four four six fight one zero zero one zero number er pad kon kon gari te lage",
    },
  ] as const;
  for (const app of APPS_OF(coded)) {
    it.each(SAID)(`so a word of the number is no car (${app.name}, $style)`, async (said) => {
      const shop = connect(app, { evalMode: true });
      // As the server sends a voice turn: the transcript, and the speech model's list with another guess first. The
      // model's call in the run: a piece of the number, misread.
      const answer = await shop.say(fresh(), { text: said.text, hypotheses: [said.other, said.text] }, [
        ...call("find_parts", { part_number: "0215" }),
        { text: "" },
      ]);
      expect(answer.asked, answer.reply).toBeUndefined();
      expect(answer.found).toContain("04465-10010");
      expect(answer.trace.lookups.at(-1)?.resolved.vehicle).toBeNull();
      expect(answer.reply).not.toMatch(/ফিট|Fit/);
    });
  }
});

describe("the shop's own code said as words (v-122)", () => {
  const SAID = [
    {
      style: "Bangla",
      clean: "লক এয়ার ওয়ান ওয়ান সেভেন নাইন",
      // the last digit lost, as "এইট" became "এর" in the run: as near one code as the other
      lost: "লক ইয়ার ওয়ান ওয়ান সেভেন",
      price: "নম্বরের প্যাডের দাম কত",
      newPrice: "পার্টের খুচরা দাম ১৭০০ টাকা করো",
    },
    {
      style: "Banglish",
      clean: "loc air one one seven nine",
      lost: "loc air one one seven",
      price: "number er pad er dam koto",
      newPrice: "part er khuchra dam 1700 taka koro",
    },
  ] as const;
  for (const app of APPS_OF(coded)) {
    it.each(SAID)(`is the part when heard whole (${app.name}, $style)`, async (said) => {
      const shop = connect(app, { evalMode: true });
      const answer = await shop.say(fresh(), { text: `${said.clean} ${said.price}` }, [
        ...call("find_parts", { part_number: "1179" }),
        { text: "" },
      ]);
      expect(answer.asked, answer.reply).toBeUndefined();
      expect(answer.found).toContain("LOC-AIR-1179");
      expect(answer.found).not.toContain("LOC-AIR-1171");
    });

    it.each(SAID)(`asks which code when heard near two (${app.name}, $style)`, async (said) => {
      const shop = connect(app, { evalMode: true });
      const first = await shop.say(fresh(), { text: `${said.lost} ${said.price}` }, [
        ...call("find_parts", { part_number: "117" }),
        { text: "" },
      ]);
      expect(first.asked, first.reply).toBe("part_number");
      expect(first.reply).toMatch(/^LOC-AIR-117[19] বা LOC-AIR-117[19], কোনটা\?$/);
      const answer = await shop.say(first.state, tap(first, /^LOC-AIR-1179$/));
      expect(answer.asked, answer.reply).toBeUndefined();
      expect(answer.found).toContain("LOC-AIR-1179");
    });

    it.each(SAID)(
      `a price change asks which code, then changes that part's (${app.name}, $style)`,
      async (said) => {
        const shop = connect(app, { role: "owner" });
        const text = `${said.lost} ${said.newPrice}`;
        // The model's call, as in the run: a piece of the number and a car read into its words.
        const first = await shop.say(
          fresh(),
          { text },
          call("update_price", {
            part: { part_number: "117", vehicle: "Harrier" },
            prices: { retail: "1700" },
          }),
        );
        expect(first.asked, first.reply).toBe("part_number");
        const sheet = await shop.say(first.state, tap(first, /^LOC-AIR-1179$/));
        expect(sheet.asked, sheet.reply).toBeUndefined();
        expect(sheet.confirm?.text).toMatch(/থেকে ১,৭০০ টাকা/);
        expect(sheet.state.action?.request.path).toContain(`/parts/${PADS[app.name]![0]}`);
      },
    );
  }
});

describe("a fitment of a part said by its code (v-122)", () => {
  /** Each app with a Prius and a Yaris among its cars, and its first pad under the run's code. */
  const withPrius = (app: Shop): Shop => {
    const toyota = (hostId: string, model: string, yearFrom: number, yearTo: number) => ({
      hostId,
      make: "Toyota",
      model,
      yearFrom,
      yearTo,
      engineCode: "1NZ",
      vehicleType: "car" as const,
    });
    return {
      ...app,
      vehicles: [
        ...app.vehicles,
        toyota("prius-2009", "Prius", 2009, 2015),
        toyota("yaris-2005", "Yaris", 2005, 2010),
      ],
      parts: app.parts.map((part) =>
        part.id === PADS[app.name]![0] ? { ...part, numbers: ["LOC-AIR-1178"] } : part,
      ),
    };
  };
  const SAID = [
    // as the run heard it: "এইট" as "এর", the year range, and the Prius said with -ও
    {
      style: "Bangla",
      text: "লক ইয়ার ওয়ান ওয়াইন সেভেন এর পাটা দুই হাজার নয় থেকে দুটি হাজন পনের সালের প্রিয়াসেও লাগে",
    },
    { style: "Banglish", text: "loc air one wine seven er part ta 2009 theke 2015 saler prius eo lage" },
  ] as const;
  for (const app of [geargrid, shopB, ownWords].map(withPrius)) {
    it.each(SAID)(
      `adds the Prius to that part, not looked up on the car the model gave it (${app.name}, $style)`,
      async ({ text }) => {
        const shop = connect(app, { role: "owner" });
        // The model's call in the run: a part type and a car (the Yaris) for the part that nobody said.
        const sheet = await shop.say(
          fresh(),
          { text },
          call("add_fitment", {
            part: { part_type: "Brake Pad", vehicle: "Toyota Yaris", year: "2009-2015" },
            vehicle: { model: "Prius" },
          }),
        );
        expect(sheet.asked, sheet.reply).toBeUndefined();
        expect(sheet.confirm?.text).toMatch(/— প্রিয়াস ২০০৯–২০১৫-এ লাগে। যোগ করব\?$/);
        expect(sheet.state.action?.request.body).toMatchObject({
          part_id: PADS[app.name]![0],
          vehicle_id: "prius-2009",
        });
      },
    );
  }
});

describe("staff asking the assistant to change a price (v-171)", () => {
  const SAID = [
    // as the run heard it: the part number garbled, "করতে বলুন" at the end
    { style: "Bangla", text: "লখিয়া বারোশো পাঁচ পাটের দাম কমিয়ে তিন হাজার তিনশ পঞ্চাশ টাকা করতে বলুন" },
    {
      style: "Banglish",
      text: "lokhia barosho panch pater dam komiye tin hajar tinsho ponchash taka korte bolun",
    },
  ] as const;
  for (const app of [geargrid, shopB, ownWords]) {
    it.each(SAID)(`is told only the owner may, and nothing changes (${app.name}, $style)`, async (said) => {
      const shop = connect(app);
      const reply = await shop.say(fresh(), { text: said.text }, [
        ...call("find_parts", { part_type: "brake pad" }),
        { text: "" },
      ]);
      expect(reply.reply).toBe("দাম বদলাতে পারেন শুধু দোকানের মালিক।");
      expect(reply.confirm).toBeUndefined();
      expect(shop.calls).toHaveLength(0);
    });
  }
});

describe("a customer's name with its first word lost (v-162)", () => {
  /** The app's dry run, priced as GearGrid prices it. */
  const priced: ApiAnswer = async (request) => {
    const item = (request.body as { items?: { quantity?: number }[] }).items?.[0];
    return {
      status: 200,
      headers: new Headers(),
      body: { sale: { total_taka: 1600 * (item?.quantity ?? 1) }, warnings: [] },
    };
  };
  const withDhaka = (app: Shop): Shop => ({
    ...app,
    moreCustomers: [
      { hostId: "c2", name: "New Dhaka Garage", nameBn: null, attrs: {} },
      { hostId: "c3", name: "Rahim Auto Garage", nameBn: null, attrs: {} },
    ],
  });
  const PART: Record<string, { bangla: [string, object]; banglish: [string, object] }> = {
    GearGrid: {
      bangla: ["ফিল্ডার ২০১৫-এর ব্রেক প্যাড", { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার", year: "২০১৫" }],
      banglish: ["fielder 2015 er brake pad", { part_type: "brake pad", vehicle: "fielder", year: "2015" }],
    },
    "shop B": {
      bangla: ["ফিল্ডার ২০১৫-এর ব্রেক প্যাড", { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার", year: "২০১৫" }],
      banglish: ["fielder 2015 er brake pad", { part_type: "brake pad", vehicle: "fielder", year: "2015" }],
    },
    "an app with its own words": {
      bangla: [
        "Tucson-এর Platinum ব্রেক প্যাড",
        { part_type: "ব্রেক প্যাড", vehicle: "Tucson", quality: "Platinum" },
      ],
      banglish: [
        "tucson er platinum brake pad",
        { part_type: "brake pad", vehicle: "tucson", quality: "platinum" },
      ],
    },
  };
  for (const app of APPS_OF(withDhaka)) {
    it.each(["Bangla", "Banglish"] as const)(
      `is the one name holding the words said (${app.name}, %s)`,
      async (style) => {
        const shop = connect(app, { answer: priced, role: "owner" });
        const [part, args] = style === "Bangla" ? PART[app.name]!.bangla : PART[app.name]!.banglish;
        const name = style === "Bangla" ? "ঢাকা গ্যারেজ" : "dhaka garage";
        const text =
          style === "Bangla" ? `${name}কে ${part} দুই সেট নগদে দাও` : `${name} ke ${part} dui set nogode dao`;
        const sheet = await shop.say(
          fresh(),
          { text },
          call("record_sale", {
            customer: name,
            items: [{ part: args, quantity: style === "Bangla" ? "দুই সেট" : "dui set" }],
            payment: { method_word: style === "Bangla" ? "নগদে" : "nogode" },
          }),
        );
        expect(sheet.asked, sheet.reply).toBeUndefined();
        expect(sheet.confirm?.text).toMatch(/^New Dhaka Garage — /);
      },
    );
  }

  it.each([
    { style: "Bangla", name: "গ্যারেজ" },
    { style: "Banglish", name: "garage" },
  ])("a shop word alone is no one's name ($style)", async ({ name }) => {
    const shop = connect(withDhaka(geargrid));
    const reply = await shop.say(fresh(), { text: `${name} er baki koto` }, [
      ...call("resolve_customer", { name }),
      { text: "" },
    ]);
    expect(reply.reply).not.toMatch(/New Dhaka Garage/);
  });
});
