import { describe, expect, it } from "vitest";
import { connect, fresh, geargrid, ownWords, shopB, type Shop } from "../../test/sale-apps";
import type { Step } from "../../test/scripted-llm";

// The open half run again after D252 (D253): a year the model cut to its hundreds (v-037), a rack said as one word in
// a question (v-086), and which rack a car's part is on asked while the model wrote its own query (v-030). On the
// three app shapes of D167, in Bangla and in Banglish (D96).

const call = (name: string, args: object): Step[] => [{ calls: [{ name, arguments: { ...args } }] }];

/** Each app's part said with a car and a year, the year in words, and the year the words say. */
const YEARS: { app: Shop; bangla: string; banglish: string; part: object; year: number }[] = [
  {
    app: geargrid,
    bangla: "ফিল্ডার দুই হাজার পনেরো সালের ব্রেক প্যাড আছে",
    banglish: "fielder dui hajar ponero saler brake pad ache",
    part: { part_type: "brake pad", vehicle: "Fielder" },
    year: 2015,
  },
  {
    app: shopB,
    bangla: "ফিল্ডার দুই হাজার পনেরো সালের ব্রেক প্যাড আছে",
    banglish: "fielder dui hajar ponero saler brake pad ache",
    part: { part_type: "brake pad", vehicle: "Fielder" },
    year: 2015,
  },
  {
    app: ownWords,
    // as the run heard 2020: "দুই হাজার বিশ্বের"
    bangla: "Tucson দুই হাজার বিশ্বের Platinum ব্রেক প্যাড আছে",
    banglish: "tucson dui hajar bish saler platinum brake pad ache",
    part: { part_type: "brake pad", vehicle: "Tucson", quality: "Platinum" },
    year: 2020,
  },
];

describe("a year the model cut to its hundreds (v-037)", () => {
  for (const { app, bangla, banglish, part, year } of YEARS) {
    it.each([
      { style: "Bangla", text: bangla },
      { style: "Banglish", text: banglish },
    ])(`is the year the words say (${app.name}, $style)`, async ({ text }) => {
      const shop = connect(app, { evalMode: true });
      // The model's call in the run: the thousands of the year, the rest left out.
      const answer = await shop.say(fresh(), { text }, [
        ...call("find_parts", { ...part, year: "2000" }),
        { text: "" },
      ]);
      expect(answer.trace.lookups[0]?.resolved.year, answer.reply).toBe(year);
      expect(answer.reply).not.toMatch(/২০০০/);
    });
  }
});

/** Each app with its first pad on rack B-2, among the test shop's 31 rack labels, so B-2 is one of many as in the run. */
const FIRST_PAD: Record<string, string> = {
  GearGrid: "pad-new",
  "shop B": "1",
  "an app with its own words": "tc-platinum",
};
const LABELS = [
  ...[
    "A-1",
    "A-2",
    "A-3",
    "A-4",
    "A-5",
    "A-6",
    "A-7",
    "B-1",
    "B-2",
    "B-3",
    "B-4",
    "B-5",
    "B-6",
    "B-7",
    "B-8",
  ],
  ...[
    "C-1",
    "C-2",
    "D-1",
    "D-2",
    "D-3",
    "D-4",
    "D-5",
    "E-1",
    "F-1",
    "F-2",
    "G-1",
    "G-2",
    "G-3",
    "G-4",
    "H-1",
    "H-2",
  ],
];
const onB2 = (app: Shop): Shop => ({ ...app, catalogRacks: { [FIRST_PAD[app.name]!]: LABELS } });

describe("a rack said as one word in a question (v-086)", () => {
  for (const app of [geargrid, shopB, ownWords].map(onB2)) {
    it.each([
      // as the run heard "B-2 তাকে": glued into one word (speech-to-text writes Bangla letters)
      { style: "Bangla", text: "বিটু তাকে কি কি মাল আছে" },
      // typed in Banglish, as people write a label in chat
      { style: "Banglish", text: "b2 take ki ki mal ache" },
    ])(`is named to the LLM as the shop's rack (${app.name}, $style)`, async ({ text }) => {
      const shop = connect(app);
      const answer = await shop.say(fresh(), { text }, [{ text: "" }]);
      expect(answer.prompts[0]).toMatch(/\(candidates: .*rack B-2/);
    });
  }
});

/** Each app's part said with its car, and the rack it is on (B-3 by default). */
const RACKS: { app: Shop; bangla: string; banglish: string }[] = [
  {
    app: geargrid,
    bangla: "ফিল্ডার ২০১৫-এর ব্রেক প্যাড কোন তাঁকে রাখা",
    banglish: "fielder 2015 er brake pad kon take rakha",
  },
  {
    app: shopB,
    bangla: "ফিল্ডার ২০১৫-এর ব্রেক প্যাড কোন তাঁকে রাখা",
    banglish: "fielder 2015 er brake pad kon take rakha",
  },
  {
    app: ownWords,
    bangla: "Tucson-এর Platinum ব্রেক প্যাড কোন তাঁকে রাখা",
    banglish: "tucson er platinum brake pad kon take rakha",
  },
];

describe("which rack a car's part is on, the model writing its own query (v-030)", () => {
  for (const { app, bangla, banglish } of RACKS) {
    it.each([
      { style: "Bangla", text: bangla },
      { style: "Banglish", text: banglish },
    ])(`is the part search's answer (${app.name}, $style)`, async ({ text }) => {
      const shop = connect(app, { evalMode: true });
      // The model's call in the run: its own query, for a part it misread.
      const answer = await shop.say(fresh(), { text }, [
        ...call("run_read_query", {
          purpose: "Find the rack location of the part",
          sql: "SELECT name_en, rack_location FROM parts WHERE name_en ILIKE '%radio%'",
        }),
        { text: "" },
      ]);
      expect(answer.trace.tool_calls[0]?.result).toMatch(/^part_search/);
      expect(answer.reply).not.toMatch(/স্ক্রিনে দেখুন/);
      // The rack itself, or the part search's own question when the words leave more than one part.
      if (!answer.asked) expect(answer.reply).toMatch(/B-3/);
    });
  }
});

// v-037 once more (D255): in the voice run the clean-up made "বিশ্বের" (twenty) "Bajaj Discover 125", so the words said
// 2000; and a year said with an ending ("দুই হাজার পনেরোর") was read as 2000 too.
/** Each app with the test shop's motorbike among its vehicles, the name the clean-up offered (a new parts list, so the
 * app's dictionary is built again with it). */
const withBike = (app: Shop): Shop => ({
  ...app,
  parts: [...app.parts],
  vehicles: [
    ...app.vehicles,
    {
      hostId: "bajaj-discover",
      make: "Bajaj",
      model: "Discover 125",
      yearFrom: 2012,
      yearTo: 2020,
      engineCode: null,
      vehicleType: "motorcycle",
    },
  ],
});
/** Each app's part, said with its car, before the year and after it. */
const SAID_PART: Record<string, { bangla: [string, string]; banglish: [string, string]; part: object }> = {
  GearGrid: {
    bangla: ["ফিল্ডার", "ব্রেক প্যাড আছে"],
    banglish: ["fielder", "brake pad ache"],
    part: { part_type: "brake pad", vehicle: "Fielder" },
  },
  "shop B": {
    bangla: ["ফিল্ডার", "ব্রেক প্যাড আছে"],
    banglish: ["fielder", "brake pad ache"],
    part: { part_type: "brake pad", vehicle: "Fielder" },
  },
  "an app with its own words": {
    bangla: ["Tucson", "Platinum ব্রেক প্যাড আছে"],
    banglish: ["tucson", "platinum brake pad ache"],
    part: { part_type: "brake pad", vehicle: "Tucson", quality: "Platinum" },
  },
};
/** The year's last word as said: misheard (v-037's "বিশ্বের"), or with its ending. */
const YEAR_WORDS = [
  { style: "Bangla", word: "বিশ্বের", year: 2020 },
  { style: "Bangla", word: "পনেরোর", year: 2015 },
  { style: "Banglish", word: "bisshwer", year: 2020 },
  { style: "Banglish", word: "poneror", year: 2015 },
] as const;

describe("a year said with an ending, the clean-up offered a name for it (v-037, D255)", () => {
  for (const app of [geargrid, shopB, ownWords].map(withBike)) {
    it.each(YEAR_WORDS)(`“dui hajar $word” is $year (${app.name}, $style)`, async ({ style, word, year }) => {
      const said = SAID_PART[app.name]!;
      const [car, rest] = style === "Bangla" ? said.bangla : said.banglish;
      const text = `${car} ${style === "Bangla" ? "দুই হাজার" : "dui hajar"} ${word} ${rest}`;
      // The clean-up's answer in the run: the year's word as the shop's motorbike.
      const cleanup = JSON.stringify({ replaced: [{ heard: word, meant: "Bajaj Discover 125" }] });
      const shop = connect(app, { evalMode: true, cleanups: [cleanup] });
      const answer = await shop.say(fresh(), { text }, [
        ...call("find_parts", { ...said.part, year: "2000" }),
        { text: "" },
      ]);
      expect(answer.trace.lookups[0]?.resolved.year, answer.reply).toBe(year);
      expect(answer.trace.cleanup ?? []).toEqual([]);
    });
  }
});
