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
    const both = [...customers, { hostId: "c3", name: "Rahim Auto Garage", nameBn: null }];
    const options = nearHints({ text, dictionary, customers: both, suppliers }).flatMap(
      (hint) => hint.options,
    );
    expect(options.filter((option) => option.value.startsWith("Rahim"))).toEqual([]);
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
