import { describe, expect, it } from "vitest";
import { decide, keySimilarity, matchScore, phoneticKey } from "./phonetic";
import { asciiDigits, banglaDigits, normalize, stripEnding, ZERO_WIDTH_CHARS } from "./text";

const ZWNJ = ZERO_WIDTH_CHARS[1];

describe("normalize (spec 10.1)", () => {
  it("turns Bangla digits into ASCII, removes zero-width characters and lower-cases Latin", () => {
    const { tokens, text } = normalize(`এক্সিও ২০১৪${ZWNJ}-এর Brake PAD?`);
    expect(tokens).toEqual(["এক্সিও", "2014", "এর", "brake", "pad"]);
    expect(text).toBe(`এক্সিও ২০১৪${ZWNJ}-এর Brake PAD?`);
  });

  it("keeps - and / inside part numbers and rack labels, and a decimal point between digits", () => {
    expect(normalize("04465-10010, B-3; 5W-30 - 1.5 liter / ok").tokens).toEqual([
      "04465-10010",
      "b-3",
      "5w-30",
      "1.5",
      "liter",
      "ok",
    ]);
  });

  it("squeezes three or more equal Banglish letters and maps spelling variants to one form", () => {
    const variants = new Map([["shamne", "samner"]]);
    expect(normalize("acheee shamne pad", variants).tokens).toEqual(["ache", "samner", "pad"]);
  });

  it("offers each token with one grammatical ending removed", () => {
    expect(normalize("এক্সিওর নোয়ার প্যাডের axior").forms).toEqual([
      ["এক্সিওর", "এক্সিও"],
      ["নোয়ার", "নোয়া"],
      ["প্যাডের", "প্যাড"],
      ["axior", "axio"],
    ]);
    expect(stripEnding("pad")).toEqual([]);
  });

  it("converts digits both ways", () => {
    expect(asciiDigits("৪,২০০")).toBe("4,200");
    expect(banglaDigits("4,200")).toBe("৪,২০০");
  });
});

describe("phonetic key and scores (spec 10.3)", () => {
  it("gives the spec's example keys", () => {
    expect(phoneticKey("self")).toBe("slf");
    expect(phoneticKey("সেলফ")).toBe("slf");
    expect(phoneticKey("sell")).toBe("sl");
    expect(phoneticKey("dynamo")).toBe("dnm");
    expect(phoneticKey("ডায়নামো")).toBe("dnm");
    expect(phoneticKey("mobil")).toBe("mbl");
  });

  it("merges aspirated pairs and sibilants, and keeps ch apart from k", () => {
    expect(phoneticKey("খালি")).toBe(phoneticKey("কালি"));
    expect(phoneticKey("শক")).toBe(phoneticKey("shock"));
    expect(phoneticKey("chaka")).toBe(phoneticKey("চাকা"));
    expect(phoneticKey("axio")).toBe("aks");
  });

  it("scores like the architecture's example: sell is not accepted, self in hypothesis 2 is", () => {
    const sell = keySimilarity(phoneticKey("সেল"), phoneticKey("সেলফ"));
    expect(sell).toBeCloseTo(0.667, 2);
    expect(matchScore(false, sell)).toBeCloseTo(0.6, 2);
    expect(0.95 * matchScore(true, 1)).toBeCloseTo(0.95, 5);
    expect(matchScore(false, 0.5)).toBe(0);
  });

  it("decides: 0.85 understood, 0.70 to 0.85 in bold, below 0.70 or two close ones unclear", () => {
    expect(decide(0.9)).toBe("understood");
    expect(decide(0.75)).toBe("understood_bold");
    expect(decide(0.69)).toBe("unclear");
    expect(decide(0.9, 0.87)).toBe("unclear");
  });
});
