import { describe, expect, it } from "vitest";
import {
  dueAnswer,
  helpAnswer,
  noFitmentAnswer,
  partsAnswer,
  possessive,
  question,
  slotChips,
  type PartsContext,
} from "./answers";
import { AllowedFacts, factsIn, isGrounded, splitSentences } from "./grounding";
import type { PartRow } from "./resolve";

function row(overrides: Partial<PartRow>): PartRow {
  return {
    hostPartId: "x",
    name: "Front brake pad set",
    nameBn: null,
    quality: "genuine",
    position: "front",
    brand: null,
    unit: "set",
    stock: 3,
    retailTaka: 4500n,
    garageTaka: 4200n,
    wholesaleTaka: null,
    rack: "B-3",
    fitmentVerified: true,
    ...overrides,
  };
}

const axio: PartsContext = {
  vehicle: "Toyota Axio",
  year: 2014,
  partType: "Brake Pad",
  position: "front",
  tier: "retail",
};
const pads = [row({}), row({ hostPartId: "y", quality: "aftermarket", stock: 6, retailTaka: 1800n })];

describe("template answers (spec 12.2, architecture A.1)", () => {
  it("answers several kinds with their count, and a shared rack once", () => {
    expect(partsAnswer(pads, axio)).toBe(
      "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড দুই রকম আছে: জেনুইন ৩ সেট, ৪,৫০০ টাকা; নন-জেনুইন ৬ সেট, ১,৮০০ টাকা। দুটোই B-3 তাকে।",
    );
  });

  it("names the brand when two kinds share a quality, so they can be told apart", () => {
    const filters = [
      row({
        quality: "aftermarket",
        position: null,
        brand: "Denso",
        stock: 10,
        retailTaka: 420n,
        rack: "A-2",
      }),
      row({
        hostPartId: "z",
        quality: "aftermarket",
        position: null,
        brand: "Sakura",
        stock: 10,
        retailTaka: 390n,
        rack: "A-2",
      }),
    ];
    expect(partsAnswer(filters, { ...axio, partType: "Air Filter", position: null })).toBe(
      "এক্সিও ২০১৪-এর এয়ার ফিল্টার দুই রকম আছে: নন-জেনুইন (Denso) ১০ সেট, ৪২০ টাকা; নন-জেনুইন (Sakura) ১০ সেট, ৩৯০ টাকা। দুটোই A-2 তাকে।",
    );
  });

  it("answers one kind in one sentence, naming the pair it used", () => {
    const shoe = row({
      quality: "aftermarket",
      position: "rear",
      stock: 2,
      retailTaka: 1500n,
      rack: "B-4",
    });
    expect(partsAnswer([shoe], { ...axio, position: "rear" }, "Brake Shoe")).toBe(
      "এক্সিও ২০১৪-এর পেছনের নন-জেনুইন লাইনিং ২ সেট আছে, ১,৫০০ টাকা, B-4 তাকে।",
    );
  });

  it("uses the customer's tier price and says whose rate it is (D119), and leaves out what the host does not record", () => {
    const garage: PartsContext = { ...axio, tier: "garage", customer: "নিউ ঢাকা গ্যারেজ" };
    expect(partsAnswer([row({ rack: null, quality: null })], garage)).toBe(
      "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড ৩ সেট আছে, ৪,২০০ টাকা। দাম নিউ ঢাকা গ্যারেজের রেটে।",
    );
    expect(partsAnswer([pads[0]!, { ...pads[1]!, garageTaka: 1650n }], garage)).toBe(
      "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড দুই রকম আছে: জেনুইন ৩ সেট, ৪,২০০ টাকা; নন-জেনুইন ৬ সেট, ১,৬৫০ টাকা। দুটোই B-3 তাকে। দাম নিউ ঢাকা গ্যারেজের রেটে।",
    );
    // No garage price recorded: the retail price is said, so no rate is named.
    expect(partsAnswer([row({ garageTaka: null })], garage)).toBe(
      "এক্সিও ২০১৪-এর সামনের জেনুইন ব্রেক প্যাড ৩ সেট আছে, ৪,৫০০ টাকা, B-3 তাকে।",
    );
  });

  it("says when a fit is read only from the part's name (D122)", () => {
    expect(partsAnswer([row({ fitFromName: true })], axio)).toBe(
      "এক্সিও ২০১৪-এর সামনের জেনুইন ব্রেক প্যাড ৩ সেট আছে, ৪,৫০০ টাকা, B-3 তাকে। এই গাড়িতে লাগে বলে নামে লেখা আছে, নিশ্চিত নয়।",
    );
    expect(partsAnswer([pads[0]!, { ...pads[1]!, fitFromName: true }], axio)).toMatch(
      / কয়েকটা এই গাড়িতে লাগে বলে শুধু নামে লেখা আছে, নিশ্চিত নয়।$/,
    );
  });

  it("names every rack a part is kept on (D122)", () => {
    expect(partsAnswer([row({ racks: ["B-3", "G-1"] })], axio)).toBe(
      "এক্সিও ২০১৪-এর সামনের জেনুইন ব্রেক প্যাড ৩ সেট আছে, ৪,৫০০ টাকা, B-3 আর G-1 তাকে।",
    );
    expect(partsAnswer([row({ racks: ["B-3", "G-1", "C-2"] })], axio)).toContain("B-3, G-1 আর C-2 তাকে।");
  });

  it("says the position every kind shares when none was asked, and none when they differ (D120)", () => {
    expect(partsAnswer(pads, { ...axio, position: null })).toBe(partsAnswer(pads, axio));
    const mixed = [
      row({}),
      row({ hostPartId: "y", position: "rear", quality: "aftermarket", retailTaka: 1800n }),
    ];
    expect(partsAnswer(mixed, { ...axio, position: null })).toMatch(
      /^এক্সিও ২০১৪-এর ব্রেক প্যাড দুই রকম আছে/,
    );
  });

  it("says when nothing is in stock, and when no fitment is recorded", () => {
    expect(partsAnswer([row({ stock: 0 })], axio)).toBe("এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড এখন স্টকে নেই।");
    expect(noFitmentAnswer({ ...axio, partType: "Horn", position: null }, [])).toBe(
      "এক্সিও ২০১৪-এর হর্ন রেকর্ডে পাওয়া যায়নি।",
    );
  });

  it("uses the year range when no year was asked", () => {
    expect(partsAnswer([row({})], { ...axio, year: null, yearRange: [2012, 2017] })).toContain(
      "এক্সিও ২০১২–২০১৭-এর",
    );
  });

  it("writes dues, the help answer and the possessive", () => {
    expect(dueAnswer("রহিম মোটরস", 19200n)).toBe("রহিম মোটরসের বাকি ১৯,২০০ টাকা।");
    expect(possessive("এক্সিও")).toBe("এক্সিওর");
    expect(helpAnswer()).toContain("পার্ট খুঁজতে পারি");
  });

  it("asks template questions, starting with what is understood", () => {
    expect(question({ slot: "year", vehicle: "Toyota Noah" })).toBe("কোন বছরের নোয়া?");
    expect(question({ slot: "customer", names: ["রহিম মোটরস", "রহিম অটো গ্যারেজ"] })).toBe(
      "রহিম মোটরস নাকি রহিম অটো গ্যারেজ?",
    );
    expect(
      question({ slot: "quantity", unit: "set", understood: "রহিম মোটরস, এক্সিওর সামনের ব্রেক প্যাড" }),
    ).toBe("রহিম মোটরস, এক্সিওর সামনের ব্রেক প্যাড — কয় সেট?");
    // the write path's own questions (D135)
    expect(question({ slot: "amount" })).toBe("কত টাকা?");
    expect(question({ slot: "unit_price", unit: "liter" })).toBe("প্রতি লিটার দাম কত?");
    expect(question({ slot: "unit_cost", unit: "set" })).toBe("প্রতি সেট কেনা দাম কত?");
    expect(question({ slot: "supplier" })).toBe("কার কাছ থেকে?");
    expect(question({ slot: "payment" })).toBe("বাকিতে না নগদে?");
  });

  it("offers chips with price and stock", () => {
    expect(
      slotChips("quality", [
        { value: "genuine", rows: [pads[0]!], priceTaka: 4500n, stock: 3 },
        { value: "aftermarket", rows: [pads[1]!], priceTaka: 1800n, stock: 6 },
      ]),
    ).toEqual([
      { id: "opt-1", label: "জেনুইন", sublabel: "৪,৫০০ টাকা, ৩ সেট আছে" },
      { id: "opt-2", label: "নন-জেনুইন", sublabel: "১,৮০০ টাকা, ৬ সেট আছে" },
    ]);
  });
});

describe("grounding (spec 12.1)", () => {
  const allowed = new AllowedFacts().addResult(pads).addNumber(2014);

  it("passes a sentence whose numbers and racks come from the results, the user and the row count", () => {
    for (const sentence of splitSentences(partsAnswer(pads, axio))) {
      expect(isGrounded(sentence, allowed), sentence).toMatchObject({ ok: true });
    }
  });

  it("drops a sentence with an invented price, stock or rack", () => {
    expect(isGrounded("জেনুইন প্যাড ৫,০০০ টাকা।", allowed)).toEqual({ ok: false, unknown: ["5000"] });
    expect(isGrounded("দুটোই C-9 তাকে।", allowed)).toEqual({ ok: false, unknown: ["C-9"] });
    expect(isGrounded("সাত সেট আছে।", allowed).ok).toBe(false);
  });

  it("reads Bangla and Latin digits, grouping commas and number words, and not নয় as nine", () => {
    expect(factsIn("১,২৩,৪৫০ টাকা, 12.50, দুটো, এটা জেনুইন নয়")).toEqual({
      numbers: ["123450", "12.5", "2"],
      racks: [],
    });
  });

  it("allows numbers inside names from the results (Alto 800, 5W-30)", () => {
    const names = new AllowedFacts().addResult({ name: "Suzuki Alto 800", oil: "5W-30" });
    expect(isGrounded("অল্টো 800-এর জন্য 5W-30 আছে।", names).ok).toBe(true);
  });
});

describe("sentences (spec 12.3)", () => {
  it("splits at danda, question and exclamation marks, joins short pieces and splits long ones at commas", () => {
    expect(splitSentences("হ্যাঁ। এক্সিওর প্যাড আছে। কোনটা লাগবে?")).toEqual([
      "হ্যাঁ। এক্সিওর প্যাড আছে।",
      "কোনটা লাগবে?",
    ]);
    const long = Array.from({ length: 12 }, (_, i) => `অংশ নম্বর ${i + 1} এর বর্ণনা`).join(", ");
    expect(splitSentences(long).every((piece) => piece.length <= 180)).toBe(true);
  });
});
