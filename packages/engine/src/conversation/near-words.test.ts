import { buildDictionary } from "@dokaanbondhu/core";
import { describe, expect, it } from "vitest";
import { applyCleanup, cleanupMessage, nearHints } from "./near-words";

// The LLM understands near words (D153): the words the matcher cannot place get the shop's nearest names by sound,
// and only a listed name the LLM chooses is put into the sentence.

const dictionary = buildDictionary();
const customers = [
  { hostId: "c1", name: "Rahim Motors", nameBn: null },
  { hostId: "c2", name: "New Dhaka Garage", nameBn: null },
];
const suppliers = [
  { hostId: "s1", name: "Nawabpur Auto Parts Ltd.", nameBn: null },
  { hostId: "s2", name: "Japan Auto Parts Importer", nameBn: null },
];
const hintsOf = (text: string) => nearHints({ text, dictionary, customers, suppliers });

describe("near-word hints", () => {
  it.each([
    { style: "Bangla", text: "এসডিও দুই হাজার চৌদ্দ সামনের ব্রেক প্যাড আছে", heard: "এসডিও" },
    { style: "Banglish", text: "esdio 2014 samner brake pad ache", heard: "esdio" },
  ])("offers the shop's car that sounds like a misheard one ($style)", ({ text, heard }) => {
    const [hint, ...rest] = hintsOf(text);
    expect(rest).toEqual([]);
    expect(hint).toMatchObject({
      heard,
      options: [expect.objectContaining({ value: "Toyota Axio", label: "এক্সিও" })],
    });
  });

  it.each([
    { style: "Bangla", text: "নওয়াপুর অটোপাস" },
    { style: "Banglish", text: "nowapur autopas" },
  ])("takes a two-word name whole ($style)", ({ text }) => {
    expect(hintsOf(text)).toMatchObject([
      { heard: text, size: 2, options: [{ kind: "supplier", value: "Nawabpur Auto Parts Ltd." }] },
    ]);
  });

  it.each([
    { style: "Bangla", text: "নাওয়াবপুর থেকে এক্সিওর অয়েল ফিল্টার দশটা কিনলাম", heard: "নাওয়াবপুর" },
    { style: "Banglish", text: "nawabpur theke axio r oil filter dosh ta kinlam", heard: "nawabpur" },
  ])("offers a supplier said by the first word of its name (D157; $style)", ({ text, heard }) => {
    const [hint, ...rest] = hintsOf(text);
    expect(rest).toEqual([]);
    expect(hint?.heard).toBe(heard);
    expect(hint?.options[0]).toMatchObject({ kind: "supplier", value: "Nawabpur Auto Parts Ltd." });
  });

  it.each([
    "প্রোভোক্স দুই হাজারের এয়ার ফিল্টার কোনটা কে", // হাজারের, a number with its ending, sounds like Harrier (D157)
    "এক হাজন দুইশ টাকা", // a price as heard: never a name
    "এক্সিও দুই হাজার চৌদ্দ সামনের ব্রেক প্যাড আছে", // everything already understood
    "আজকে ঢাকায় বৃষ্টি হবে", // not about the shop
    "axio 2014 er samner brake pad ache",
    "এক্সিও ২০১৪ সামনের ব্রেক প্যাডের পাইকারি দাম কত?", // the app's own word, never ব্যাটারি (D162)
    "axio 2014 front brake pad er paikari dam koto?",
    "রহিম মোটরস থেকে বিকাশে দুই হাজার টাকা জমা নাও",
    "rahim motors theke bikashe dui hajar taka joma nao",
  ])("offers nothing for %s", (text) => {
    expect(hintsOf(text)).toEqual([]);
  });

  it.each([
    {
      style: "Bangla",
      text: "নাওয়াবপুর অটোপার্টস থেকে এক্সিও দুই হাজার চৌদ্দ সামনের নন জেনুইন ব্রেকপ্যাড পাতসেট কিনলাম",
      glued: "পাতসেট",
    },
    {
      style: "Banglish",
      text: "nawabpur autoparts theke axio 2014 samner non genuine brakepad patset kinlam",
      glued: "patset",
    },
    // "ek set" as speech-to-text wrote it on the owner's emulator: x for ks (D170).
    { style: "Bangla", text: "রহিম মোটরস এক্সিওর সামনের ব্রেক প্যাড এক্সেট ফেরত দিয়েছে", glued: "এক্সেট" },
    { style: "Banglish", text: "rohim motors axio r samner brake pad exet ferot dise", glued: "exet" },
  ])(
    "takes a unit glued to its misheard number for a quantity, never a part (D158; $style)",
    ({ text, glued }) => {
      const hints = hintsOf(text);
      expect(hints.some((hint) => hint.heard.split(" ").includes(glued))).toBe(false);
      expect(hints.flatMap((hint) => hint.options).some((option) => option.kind === "part_type")).toBe(false);
    },
  );

  it.each([
    { style: "Bangla", text: "রহিম থেকে দশ হাজার টাকা জমা নাও" },
    { style: "Banglish", text: "rahim theke dosh hajar taka joma nao" },
  ])("never guesses between two names that share their first word (D158; $style)", ({ text }) => {
    const both = [
      ...customers,
      { hostId: "c3", name: "Rahim Auto Garage", nameBn: null },
      { hostId: "c4", name: "Karim Auto", nameBn: null },
      { hostId: "c5", name: "Rafiq Uddin", nameBn: null },
    ];
    // Nor another name that sounds a little like it (D162): the matcher asks which Rahim.
    expect(nearHints({ text, dictionary, customers: both, suppliers })).toEqual([]);
    // One person's first word is still offered (D157).
    expect(hintsOf(text).flatMap((hint) => hint.options)[0]).toMatchObject({ value: "Rahim Motors" });
  });
});

describe("the LLM's choice", () => {
  const text = "নওয়াপুর অটোপাস থেকে এসডিও ২০১৪ ব্রেক প্যাড ৫ সেট কিনলাম";
  const hints = hintsOf(text);

  it("puts in only listed names, written in either script, and leaves numbers alone", () => {
    const cleaned = applyCleanup(
      text,
      hints,
      {
        replaced: [
          { heard: "নওয়াপুর অটোপাস", meant: "নবাবপুর অটো পার্টস" }, // the listed name, in Bangla letters
          { heard: "এসডিও", meant: "এক্সিও" },
          { heard: "৫", meant: "৬" }, // not an unclear word: ignored
        ],
      },
      dictionary,
    );
    expect(cleaned.text).toBe("Nawabpur Auto Parts Ltd. থেকে এক্সিও ২০১৪ ব্রেক প্যাড ৫ সেট কিনলাম");
    expect(cleaned.replaced.map(({ option }) => option.value)).toEqual([
      "Nawabpur Auto Parts Ltd.",
      "Toyota Axio",
    ]);
  });

  it("never puts in a name that is not listed, and changes nothing on a bad reply", () => {
    expect(
      applyCleanup(text, hints, { replaced: [{ heard: "এসডিও", meant: "Toyota Corolla" }] }, dictionary),
    ).toEqual({ text, replaced: [] });
    expect(applyCleanup(text, hints, "not json", dictionary)).toEqual({ text, replaced: [] });
  });

  it("asks with the sentence, the question it answers, the other guesses and each word's sounds", () => {
    const message = cleanupMessage(
      "নওয়াপুর অটোপাস",
      ["নাওয়াবপুর অটোপাস"],
      hintsOf("নওয়াপুর অটোপাস"),
      "কার কাছ থেকে?",
    );
    expect(message).toContain("It answers the shop's question: কার কাছ থেকে?");
    expect(message).toContain("Other guesses of the speech-to-text: নাওয়াবপুর অটোপাস");
    expect(message).toMatch(/"নওয়াপুর অটোপাস" \(\w[\w ]*\): Nawabpur Auto Parts Ltd\. \(/);
  });
});

// The owner's G21 on the phone (21 Oct, D178): "তিন হাজার টাকায়" written "তিন হাউজার টাকায়" (and হাইজার, হাসার in the
// other guesses) was taken for a misheard name, and the clean-up rewrote the price away.
describe("a misheard thousand is a number, never a name (D178)", () => {
  it.each([
    "রহিম মোটরসকে একজিও দুই হাজার চৌদ্দ এর সামনের নন জেনুইন ব্রেক প্যাড দুইসেট তিন হাউজার টাকায় বাকিতে দাও",
    "রহিম মোটরসকে একজিও দুই হাজার চৌদ্দ এর সামনের নন জেনুইন ব্রেক প্যাড দুইসেট তিন হাইজার টাকায় বাকিতে দাও",
    "রহিম মোটরসকে একজিও দুই হাজার চৌদ্দ এর সামনের নন জেনুইন ব্রেক প্যাড দুইসেট তিন হাসার টাকায় বাকিতে দাও",
    "Rahim Motors ke axio 2014 er samner non genuine brake pad dui set tin haujar takay bakite dao",
  ])("%s", (text) => {
    const heard = hintsOf(text).map((hint) => hint.heard);
    expect(heard.filter((words) => /হাউজার|হাইজার|হাসার|haujar/.test(words))).toEqual([]);
  });
});

// The first voice run of the test set (D237): the clean-up made a digit said in English a wiper ("ওয়াইন"), the owner's
// own words ("মালিক হিসেবে") a shop, a rack said as one word ("বিটু তাকে", B-2) a Vitz and a misheard thousand a car.
describe("a number's words, a rack and the speaker's role are never a name (D237)", () => {
  /** The test shop's customer the run's "মালিক" was made into. */
  const alif = { hostId: "c3", name: "Alif Motors", nameBn: null };
  const unplaced = (text: string, options: { racks?: string[]; keep?: [number, number][] } = {}) =>
    nearHints({ text, dictionary, customers: [...customers, alif], suppliers, ...options }).map(
      (hint) => hint.heard,
    );

  it.each([
    {
      style: "Bangla",
      text: "কেওয়াইবি থ্রি জিরো জিরো ওয়ান ওয়াইন ফাইভ নম্বরের শক অ্যাবজার্ভারের দাম",
      word: "ওয়াইন",
    },
    {
      style: "Banglish",
      text: "kyb three zero zero one wine five number er shock absorber er dam",
      word: "wine",
    },
  ])("a misheard digit beside other digits ($style)", ({ text, word }) => {
    expect(unplaced(text).filter((heard) => heard.split(" ").includes(word))).toEqual([]);
  });

  it.each([
    { style: "Bangla", text: "ডিনাই শূন্য এক পঞ্চাশ পার্টা কোন কোনটা লাগে", word: "ডিনাই" },
    { style: "Banglish", text: "dinai shunno ek ponchash part ta kon konta lage", word: "dinai" },
  ])("the words of a part number said aloud, kept as they are ($style)", ({ text, word }) => {
    expect(unplaced(text, { keep: [[0, 4]] }).filter((heard) => heard.includes(word))).toEqual([]);
  });

  it.each([
    { style: "Bangla", text: "বিটু তাকে কি কি মাল আছে", word: "বিটু" },
    { style: "Banglish", text: "bitu take ki ki mal ache", word: "bitu" },
  ])("a rack said as one word, the shop's or not ($style)", ({ text, word }) => {
    for (const racks of [["B-2", "C-1"], []])
      expect(unplaced(text, { racks }).filter((heard) => heard.includes(word))).toEqual([]);
  });

  it.each([
    { style: "Bangla", text: "মালিক হিসেবে ওয়ান সেভেন এইড জিরো পাটের খুচরা দাম এক হাজার টাকা করুন" },
    { style: "Banglish", text: "malik hishebe one seven eid zero part er khuchra dam ek hajar taka korun" },
  ])("the speaker's role said before the card ($style)", ({ text }) => {
    expect(unplaced(text).filter((heard) => /মালিক|malik/.test(heard))).toEqual([]);
  });

  it.each([
    "সিক্স পি কে পার্টা দুই হাজার এক থেকে দুইশ হারজার ছয় সালের করলাতেও লাগে",
    "মদীনা অটো ওয়ার্কসকে চারটা হেডলাইট প্রতিটি পাঁচ হাজতো পঞ্চাশ টাকা দিয়ে নগদে বিক্রি করো",
    "six p k part ta dui hajar ek theke duisho harjar choy saler corolla teo lage",
  ])("a thousand misheard in the run: %s", (text) => {
    expect(unplaced(text).filter((heard) => /হারজার|হাজতো|harjar/.test(heard))).toEqual([]);
  });
});
