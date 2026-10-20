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

// D172: a fitment added by voice or chat, the architecture's "এই প্যাডটা প্রিমিওতেও লাগে". The part is found with its
// own words (or the remembered car), never with the new car; the new car is one of the app's vehicle rows, its year,
// engine or row asked when they differ; a fit already recorded sends nothing; the confirmation names both. In
// Bangla and in Banglish (D96), on the three app shapes of D167.

const fitCall = (args: object): Step[] => [{ calls: [{ name: "add_fitment", arguments: { ...args } }] }];

async function tapAll(
  shop: ReturnType<typeof connect>,
  reply: Reply,
  labels: readonly RegExp[],
): Promise<Reply> {
  let current = reply;
  for (const label of labels) current = await shop.say(current.state, tap(current, label));
  return current;
}

/** Each app's fitment: what is said, the buttons to the sheet, and what the app gets. */
const CASES: {
  app: Shop;
  said: { style: string; text: string; args: object }[];
  taps: RegExp[];
  sheet: RegExp;
  body: Record<string, unknown>;
}[] = [
  {
    app: geargrid,
    said: [
      {
        style: "Bangla",
        text: "ফিল্ডার ২০১৫-এর ব্রেক প্যাড প্রিমিওতেও লাগে",
        args: {
          part: { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার", year: "২০১৫" },
          vehicle: { model: "প্রিমিও" },
        },
      },
      {
        style: "Banglish",
        text: "fielder 2015 er brake pad premio teo lage",
        args: {
          part: { part_type: "brake pad", vehicle: "fielder", year: "2015" },
          vehicle: { model: "premio" },
        },
      },
    ],
    // The Premio's two generations: its year is asked, with the rows' years.
    taps: [/^2007–2011$/],
    sheet: /^ফিল্ডারের সামনের ব্রেক প্যাড, জেনুইন — প্রিমিও ২০০৭–২০১১-এ লাগে। যোগ করব\?$/,
    body: { part_id: "pad-new", vehicle_id: "premio-2007", verified: true },
  },
  {
    app: shopB,
    said: [
      {
        style: "Bangla",
        text: "এক্সিও ২০১৫-এর ব্রেক প্যাড ফিল্ডারেও লাগে",
        args: {
          part: { part_type: "ব্রেক প্যাড", vehicle: "এক্সিও", year: "২০১৫" },
          vehicle: { model: "ফিল্ডার" },
        },
      },
      {
        style: "Banglish",
        text: "axio 2015 er brake pad fielder eo lage",
        args: {
          part: { part_type: "brake pad", vehicle: "axio", year: "2015" },
          vehicle: { model: "fielder" },
        },
      },
    ],
    // Two pads fit the Axio chassis: the quality picks one; the app has one Fielder row.
    taps: [/নন-জেনুইন/],
    sheet: /— ফিল্ডার ২০১২–২০১৭-এ লাগে। যোগ করব\?$/,
    body: { part_id: "2", vehicle_id: "2" },
  },
  {
    app: ownWords,
    said: [
      {
        style: "Bangla",
        text: "Tucson-এর Platinum ব্রেক প্যাড পাজেরোতেও লাগে",
        args: {
          part: { part_type: "ব্রেক প্যাড", vehicle: "Tucson", quality: "Platinum" },
          vehicle: { model: "পাজেরো" },
        },
      },
      {
        style: "Banglish",
        text: "tucson er platinum brake pad pajero teo lage",
        args: {
          part: { part_type: "brake pad", vehicle: "tucson", quality: "platinum" },
          vehicle: { model: "pajero" },
        },
      },
    ],
    // The Pajero rows have no years: their engine codes tell them apart.
    taps: [/^4D56$/],
    sheet: /— পাজেরো 4D56-এ লাগে। যোগ করব\?$/,
    body: { part_id: "tc-platinum", vehicle_id: "pj-a", verified: true },
  },
];

for (const { app, said, taps, sheet, body } of CASES) {
  describe(`${app.name}: a fitment added (D172)`, () => {
    it.each(said)(
      "the part by its own words, the new car among the app's ($style)",
      async ({ text, args }) => {
        const shop = connect(app);
        const first = await shop.say(fresh(), { text }, fitCall(args));
        const reply = await tapAll(shop, first, taps);
        expect(reply.asked).toBeUndefined();
        expect(reply.confirm?.text).toMatch(sheet);
        expect(reply.state.action?.request).toMatchObject({ method: "POST", path: "/api/v1/fitments" });
        expect(reply.state.action?.request.body).toMatchObject(body);
        expect(shop.calls).toHaveLength(0); // no dry run: nothing is sent before yes
      },
    );
  });
}

const GG = [
  {
    style: "Bangla",
    fielder: { part_type: "ব্রেক প্যাড", vehicle: "ফিল্ডার", year: "২০১৫" },
    premio: "ফিল্ডার ২০১৫-এর ব্রেক প্যাড প্রিমিওতেও লাগে",
    noah: "ফিল্ডার ২০১৫-এর ব্রেক প্যাড নোয়াতেও লাগে",
    ask: "ফিল্ডার ২০১৫-এর ব্রেক প্যাড আছে?",
    thisOne: "এই প্যাডটা প্রিমিও ২০০৯-তেও লাগে",
    thisArgs: { part: { part_type: "প্যাড" }, vehicle: { model: "প্রিমিও", year: "২০০৯" } },
    model: { premio: "প্রিমিও", noah: "নোয়া" },
  },
  {
    style: "Banglish",
    fielder: { part_type: "brake pad", vehicle: "fielder", year: "2015" },
    premio: "fielder 2015 er brake pad premio teo lage",
    noah: "fielder 2015 er brake pad noah teo lage",
    ask: "fielder 2015 er brake pad ache?",
    thisOne: "ei pad ta premio 2009 teo lage",
    thisArgs: { part: { part_type: "pad" }, vehicle: { model: "premio", year: "2009" } },
    model: { premio: "premio", noah: "noah" },
  },
] as const;

describe("which car, and a fit the app has already (GearGrid, D172)", () => {
  it.each(GG)("a fit already recorded: says so, and nothing is sent ($style)", async (said) => {
    const shop = connect(geargrid);
    const first = await shop.say(
      fresh(),
      { text: said.premio },
      fitCall({ part: said.fielder, vehicle: { model: said.model.premio } }),
    );
    const reply = await shop.say(first.state, tap(first, /^2012–2017$/));
    expect(reply.reply).toBe("এটা আগে থেকেই রেকর্ডে আছে।");
    expect(reply.confirm).toBeUndefined();
    expect(shop.calls).toHaveLength(0);
  });

  it.each(GG)("a car the app does not have: says to add it in the app ($style)", async (said) => {
    const shop = connect(geargrid);
    const reply = await shop.say(
      fresh(),
      { text: said.noah },
      fitCall({ part: said.fielder, vehicle: { model: said.model.noah } }),
    );
    expect(reply.reply).toBe("নোয়া অ্যাপের গাড়ির তালিকায় নেই; আগে অ্যাপে গাড়িটা যোগ করুন।");
    expect(reply.confirm).toBeUndefined();
  });

  it.each(GG)("“this pad” is the remembered car's, never the new car's ($style)", async (said) => {
    const shop = connect(geargrid);
    const asked = await shop.say(fresh(), { text: said.ask }, [
      { calls: [{ name: "find_parts", arguments: { ...said.fielder } }] },
      { text: "" },
    ]);
    const reply = await shop.say(asked.state, { text: said.thisOne }, fitCall(said.thisArgs));
    expect(reply.confirm?.text).toMatch(
      /^ফিল্ডারের সামনের ব্রেক প্যাড, জেনুইন — প্রিমিও ২০০৭–২০১১-এ লাগে। যোগ করব\?$/,
    );
    expect(reply.state.action?.request.body).toMatchObject({ part_id: "pad-new", vehicle_id: "premio-2007" });
  });

  // The owner's G14 on the phone (20 Oct): by voice, the model's call left out the part type the request says plainly,
  // and "কোন পার্ট লাগবে?" was asked. The request's own words complete the part, never with the new car.
  it.each(GG)("a part type the model leaves out is the request's own ($style)", async (said) => {
    const shop = connect(geargrid);
    const part = { vehicle: said.fielder.vehicle, year: said.fielder.year };
    const first = await shop.say(
      fresh(),
      { text: said.premio },
      fitCall({ part, vehicle: { model: said.model.premio } }),
    );
    expect(first.reply).toBe("কোন বছরের প্রিমিও?");
    const reply = await shop.say(first.state, tap(first, /^2007–2011$/));
    expect(reply.confirm?.text).toMatch(
      /^ফিল্ডারের সামনের ব্রেক প্যাড, জেনুইন — প্রিমিও ২০০৭–২০১১-এ লাগে। যোগ করব\?$/,
    );
  });

  it.each(GG)("a year the model adds to the new car is not taken: it is asked ($style)", async (said) => {
    const shop = connect(geargrid);
    const reply = await shop.say(
      fresh(),
      { text: said.premio },
      fitCall({ part: said.fielder, vehicle: { model: said.model.premio, year: "2009" } }),
    );
    expect(reply.reply).toBe("কোন বছরের প্রিমিও?");
    expect(reply.choices?.options.map((option) => option.label)).toEqual(["2007–2011", "2012–2017"]);
  });
});

// The owner's G15 on the phone (20 Oct, D174): "এই প্যাটটা প্রিমিওতেও লাগে", pad heard as pat; the model then left the
// part out, or put the new car into it, and "কোন গাড়িতে লাগে?" did not take a car for its answer.
const G15 = [
  {
    style: "Bangla",
    ask: "এক্সিও ২০১৪-এর ব্রেক প্যাড আছে?",
    axio: { part_type: "ব্রেক প্যাড", vehicle: "এক্সিও", year: "২০১৪" },
    pat: "এই প্যাটটা প্রিমিওতেও লাগে",
    premio: "প্রিমিও",
    unknownCar: "এক্সিও ২০১৪-এর ব্রেক প্যাড ল্যান্ড ক্রুজারেও লাগে",
  },
  {
    style: "Banglish",
    ask: "axio 2014 er brake pad ache?",
    axio: { part_type: "brake pad", vehicle: "axio", year: "2014" },
    pat: "ei pat ta premio teo lage",
    premio: "premio",
    unknownCar: "axio 2014 er brake pad land cruiser eo lage",
  },
] as const;

describe("the owner's G15: pat, the new car, and the car asked (GearGrid, D174)", () => {
  const axioAsked = async (shop: ReturnType<typeof connect>, said: (typeof G15)[number]) =>
    shop.say(fresh(), { text: said.ask }, [
      { calls: [{ name: "find_parts", arguments: { ...said.axio } }] },
      { text: "" },
    ]);
  const sheet = /^এক্সিওর সামনের ব্রেক প্যাড, জেনুইন — প্রিমিও ২০০৭–২০১১-এ লাগে। যোগ করব\?$/;

  it.each(G15)("pad heard as pat, left out of the call: the remembered Axio's pad ($style)", async (said) => {
    const shop = connect(geargrid);
    const asked = await axioAsked(shop, said);
    const first = await shop.say(
      asked.state,
      { text: said.pat },
      fitCall({ part: {}, vehicle: { model: said.premio } }),
    );
    expect(first.reply).toBe("কোন বছরের প্রিমিও?");
    const reply = await shop.say(first.state, tap(first, /^2007–2011$/));
    expect(reply.confirm?.text).toMatch(sheet);
    expect(reply.state.action?.request.body).toMatchObject({ part_id: "pad-new", vehicle_id: "premio-2007" });
  });

  it.each(G15)(
    "the new car put into the part, none as the car it fits: the words decide ($style)",
    async (said) => {
      const shop = connect(geargrid);
      const asked = await axioAsked(shop, said);
      const first = await shop.say(
        asked.state,
        { text: said.pat },
        fitCall({ part: { part_type: "প্যাড", vehicle: said.premio } }),
      );
      expect(first.reply).toBe("কোন বছরের প্রিমিও?");
      const reply = await shop.say(first.state, tap(first, /^2007–2011$/));
      expect(reply.confirm?.text).toMatch(sheet);
    },
  );

  it.each(G15)("“কোন গাড়িতে লাগে?” takes a car for its answer ($style)", async (said) => {
    const shop = connect(geargrid);
    const first = await shop.say(fresh(), { text: said.unknownCar }, fitCall({ part: { ...said.axio } }));
    expect(first.reply).toBe("কোন গাড়িতে লাগে?");
    const reply = await shop.say(first.state, { text: said.premio });
    expect(reply.reply).toBe("কোন বছরের প্রিমিও?");
  });
});

describe("the fitment's tool (D172)", () => {
  it("names the part as known and the car it also fits", () => {
    const tool = writeTool(appCapability("add_fitment"));
    const parameters = tool.function.parameters as {
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
    expect(Object.keys(parameters.properties).sort()).toEqual(["note", "part", "vehicle"]);
    expect(Object.keys(parameters.properties.vehicle!.properties!).sort()).toEqual([
      "engine",
      "model",
      "year",
    ]);
  });
});
