import { describe, expect, it } from "vitest";
import { asksPhone, phoneAnswer, phoneOf, writeCueOf } from "./actions";
import { buildDictionary } from "./glossary";
import { rackSaid } from "./names";
import { isNumberWord, parseYear } from "./numbers";
import { matchConcept } from "./glossary";
import { digitRun, digitsBySound, gluedRack, partNumberBySound } from "./spoken-numbers";
import { normalize } from "./text";

// Numbers said sign by sign (D237), from the first voice run of the test set: every heard sentence below is how
// speech-to-text wrote a speaker's clip. In Bangla and in Banglish (D96).

/** The test shop's part numbers that sound most alike: each run's number among its near neighbours. */
const KNOWN = [
  "04465-10010", "04465-10047", "04465-10084", "04465-10121", "04465-10158", "04465-10195", "04465-10232",
  "04465-10269", "04465-10306", "04465-10343", "04465-10380", "04465-10K010", "04465-47K047", "04465-84K084",
  "04465-TA0-K10", "04465-TL7-H47", "04465-TW4-E84", "17801-10010", "17801-10047", "17801-10084", "17801-10121",
  "17801-10158", "17801-10195", "17801-10K010", "6PK1101", "6PK1108", "6PK1115", "6PK1122", "6PK1129", "6PK1136",
  "6PK1143", "DNAI-0150", "DNAI-0178", "DNAI-0206", "DNAI-0318", "DNO2-0129", "DNO2-0143", "DNSP-0115",
  "DNSP-0199", "KYB-300101", "KYB-300108", "KYB-300115", "KYB-300122", "KYB-300129", "KYB-300136", "KYB-300143",
  "KYB-300150", "KYB-300157", "KYB-300164", "KYB-300171", "KYB-300178", "KYB-300185",
]; // prettier-ignore

describe("a digit word, misheard or glued (D237)", () => {
  it.each([
    {
      style: "Bangla",
      words: ["জিলো", "জিনো", "ওয়াইন", "ওয়াংওয়ান", "ওয়ানটু", "এইড", "নাউন", "সেভন", "ফোট"],
    },
    { style: "Banglish", words: ["jilo", "jino", "wine", "oneone", "onetu", "eid", "naun", "sebn", "fot"] },
  ])("is its digits by sound ($style)", ({ words }) => {
    expect(words.map(digitsBySound)).toEqual(["0", "0", "1", "11", "12", "8", "9", "7", "4"]);
  });

  it.each([
    { style: "Bangla", words: ["নাম্বার", "পার্ট", "আরেক", "দাম", "রাখো"] },
    { style: "Banglish", words: ["nambar", "part", "arek", "dam", "rakho"] },
  ])("an everyday word is none ($style)", ({ words }) => {
    expect(words.map(digitsBySound)).toEqual([null, null, null, null, null]);
  });

  it.each([
    { style: "Bangla", text: "ফোন নম্বর জিরো ওয়াইন ফাইভ" },
    { style: "Banglish", text: "fon nambar zero wine five" },
  ])("is read only next to a digit, so ফোন is never a four ($style)", ({ text }) => {
    const tokens = normalize(text).tokens;
    expect(digitRun(tokens)).toEqual([null, null, "0", "1", "5"]);
    expect(digitRun(tokens, { bySound: false })).toEqual([null, null, "0", null, "5"]);
  });

  it.each([
    { style: "Bangla", text: "জিরো ওয়ান আট ওয়াউন ওয়াইন টু টু ত্রি থ্রাই ফোর ফোট" },
    { style: "Banglish", text: "ziro one at waun wine two two tri thrai four fot" },
  ])("a phone is never guessed: garbled digits are asked again (D211; $style)", ({ text }) => {
    expect(phoneOf(text)).toBeNull();
  });
});

describe("a part number said aloud (D237)", () => {
  it.each([
    [
      "v-054",
      "KYB-300115",
      "কেওয়াইবি আর থ্রি জিরো জিনো ওয়ান ওয়াইন ফাইভ নম্বরের শক অ্যাবজারভারের প্রাইস কত",
    ],
    ["v-056", "04465-TA0-K10", "জিরো ফোর ফোট সিক্স ফাইভ টি ও কে টেন নম্বরের ব্রেক প্যাড আছে কিনা"],
    ["v-058", "KYB-300178", "কেওয়াইবি থ্রি জিরো জিনো ওয়ানসেট নেট নম্বরের শক অ্যাবজার্ভারের দাম কত"],
    ["v-074", "DNAI-0150", "ডিনাই শূন্য এক পঞ্চাশ পার্টা কোন কোনটা লাগে"],
    ["v-096", "DNO2-0129", "বলো তো ডিএনএ টু জিরো ওয়ান টু নাইন পার্টা কোন কোনট গাড়িতে লাগবে"],
    ["v-114", "DNSP-0199", "ডিএনএসপি জিরো ওয়ান নাইন নাউন পাটের খুচরা দাম তেরোশো টাকা করো"],
    [
      "v-145",
      "6PK1129",
      "মালিক হিসেবে সিক্স পি কে ওয়ান ওয়ানটু নাইন পার্টা দুই হাজার এক থেকে দুইশ হারজার ছয় সালের করলাতেও লাগে",
    ],
    [
      "v-167",
      "17801-10047",
      "মালিক হিসেবে ওয়ান সেভেন এইড জিরো ওয়াইন ওয়ানন্দাবল জিলো ফোর সেভন পাটের খুচরা দাম এক হাজার টাকা করুন",
    ],
  ])("as heard in %s is %s, among its near neighbours (Bangla)", (_, number, heard) => {
    expect(partNumberBySound(heard, KNOWN).number).toBe(number);
  });

  it.each([
    ["KYB-300115", "kyb three zero zero one one five number er shock er dam koto"],
    ["DNAI-0150", "DNAI zero one five zero part ta kon garite lage"],
    ["6PK1129", "six p k one one two nine part ta corolla teo lage"],
    ["17801-10047", "one seven eight zero one one double zero four seven part er dam 1000 koro"],
  ])("%s, said in Banglish", (number, heard) => {
    expect(partNumberBySound(heard, KNOWN).number).toBe(number);
  });

  it.each([
    { style: "Bangla", text: "এক্সিও দুই হাজার চৌদ্দ সামনের ব্রেক প্যাডের পার্ট নম্বর কত" },
    { style: "Bangla", text: "নোয়ার সেলফ মোটর পার্ট আছে তিনটা দুই হাজার বারো" },
    { style: "Bangla", text: "রহিম মোটরসের ফোন নম্বরটা দাও" },
    { style: "Banglish", text: "axio 2014 samner brake pad er part number koto" },
    { style: "Banglish", text: "dui set brake pad er part ta rakho" },
    { style: "Banglish", text: "ei part ta B-3 e rakho" },
  ])("ordinary words before a cue are none: $text ($style)", ({ text }) => {
    expect(partNumberBySound(text, KNOWN)).toEqual({ number: null, close: [], span: null });
  });

  it.each([
    { style: "Bangla", text: "কেওয়াইবি থ্রি জিরো জিরো ওয়ান" },
    { style: "Banglish", text: "kyb three zero zero one" },
  ])(
    "half a number names none, but gives its near ones; the part type said may pick one ($style)",
    ({ text }) => {
      const said = partNumberBySound(text, KNOWN, { anywhere: true });
      expect(said.number).toBeNull();
      expect(said.close.length).toBeGreaterThan(1);
      expect(said.close.every((number) => number.startsWith("KYB-3001"))).toBe(true);
      const only = said.close[0]!;
      expect(partNumberBySound(text, KNOWN, { anywhere: true, prefer: (n) => n === only }).number).toBe(only);
    },
  );

  it.each([
    { style: "Bangla", text: "জিরো ফোর ফোর সিক্স ফাইভ ওয়ান জিরো জিরো ওয়ান জিরো" },
    { style: "Banglish", text: "zero four four six five one zero zero one zero" },
  ])("an answer to “which part number?” needs no cue ($style)", ({ text }) => {
    expect(partNumberBySound(text, KNOWN).number).toBeNull();
    expect(partNumberBySound(text, KNOWN, { anywhere: true }).number).toBe("04465-10010");
  });
});

describe("a rack said as one word (D237)", () => {
  it.each([
    { style: "Bangla", words: ["বিটু", "সিওয়ান", "এইচওয়ান"] },
    { style: "Banglish", words: ["bitwo", "seeone", "eichone"] },
  ])("is its letter and number ($style)", ({ words }) => {
    expect(words.map(gluedRack)).toEqual(["B2", "C1", "H1"]);
  });

  it.each([
    { style: "Bangla", words: ["আরেক", "একটা", "এইটা", "সিটি", "বিশ", "জেনুইন"] },
    { style: "Banglish", words: ["arek", "ekta", "eita", "city", "bish", "genuine"] },
  ])("an everyday word is none ($style)", ({ words }) => {
    expect(words.map(gluedRack)).toEqual([null, null, null, null, null, null]);
  });

  it.each([
    { style: "Bangla", put: "ওটা সিওয়ান রেখে রাখো", moved: "বি তিন থেকে সিওয়ান এ রাখো" },
    { style: "Banglish", put: "ota seeone e rekhe rakho", moved: "b tin theke seeone e rakho" },
  ])("is the rack a change names, the last one said ($style)", ({ put, moved }) => {
    expect(rackSaid(put, ["B-3", "C-1"])).toBe("C-1");
    expect(rackSaid(moved, ["B-3", "C-1"])).toBe("C-1");
  });
});

describe("words misheard in the run (D237)", () => {
  const dictionary = buildDictionary();

  it.each([
    { style: "Bangla", text: "হেরিয়ার দুই হাজার বিশ্বের ওয়াটার পাম্প কি আছে" },
    { style: "Banglish", text: "harrier dui hajar bishwo er water pump ache" },
  ])("দুই হাজার বিশ্বের is 2020 ($style)", ({ text }) => {
    expect(parseYear(normalize(text).tokens)).toBe(2020);
  });

  it("বিশ্বের without a thousand is the word world", () => {
    expect(parseYear(normalize("বিশ্বের সেরা ব্রেক প্যাড").tokens)).toBeNull();
  });

  it.each([
    { style: "Bangla", text: "এক্সিউয়ের রেডিয়েটর কাপের দামটা দাও তো একটু" },
    { style: "Banglish", text: "axio radiator kap er dam ta dao" },
  ])("রেডিয়েটর কাপ is a radiator cap ($style)", ({ text }) => {
    expect(matchConcept("part_type", text, [], dictionary).candidates[0]?.value).toBe("Radiator Cap");
  });

  it.each(["হারজার", "হাজতো", "harjar", "hajto"])("%s is a misheard thousand, never a name", (word) => {
    expect(isNumberWord(word)).toBe(true);
  });
});

describe("a phone asked (D237)", () => {
  it.each([
    {
      style: "Bangla",
      asks: ["শফিকুল ইসলামের ফোন নম্বর কি", "রহিম মোটরসের নাম্বারটা দেন"],
      not: "রহিম মোটরসের বাকি কত",
    },
    {
      style: "Banglish",
      asks: ["shafiqul islam er phone number ki", "rahim motors er number ta den"],
      not: "rahim motors er baki koto",
    },
  ])("is told from other questions, and is never a sale ($style)", ({ asks, not }) => {
    for (const text of asks) {
      expect(asksPhone(text)).toBe(true);
      expect(writeCueOf(text, { partyNamed: true })).toBeNull();
    }
    expect(asksPhone(not)).toBe(false);
  });

  it("is said with the name, or that the app keeps none", () => {
    expect(phoneAnswer("Shafiqul Islam", "01811000202")).toBe("Shafiqul Islam-এর ফোন নম্বর ০১৮১১-০০০২০২।");
    expect(phoneAnswer("Shafiqul Islam", "01811-000202")).toBe("Shafiqul Islam-এর ফোন নম্বর ০১৮১১-০০০২০২।");
    expect(phoneAnswer("Nawabpur Auto Parts Ltd.", "02-7390001")).toBe(
      "Nawabpur Auto Parts Ltd.-এর ফোন নম্বর ০২-৭৩৯০০০১।",
    );
    expect(phoneAnswer("Rahim Motors", null)).toBe("Rahim Motors-এর ফোন নম্বর অ্যাপে নেই।");
  });
});

describe("price said in English is never a car (D237)", () => {
  const dictionary = buildDictionary();
  it.each([
    { style: "Bangla", text: "শক অ্যাবজারভারের প্রাইস কত" },
    { style: "Banglish", text: "shock absorber er price koto" },
    { style: "Banglish", text: "shock absorber er prais koto" },
  ])("$text ($style)", ({ text }) => {
    const cars = matchConcept("vehicle_model", text, [], dictionary).candidates;
    expect(cars.filter((car) => car.value === "Toyota Prius")).toEqual([]);
  });

  it("the Prius said by its name is still the Prius", () => {
    expect(
      matchConcept("vehicle_model", "প্রিয়াস ২০১৫ এর শক আছে", [], dictionary).candidates[0]?.value,
    ).toBe("Toyota Prius");
  });
});
