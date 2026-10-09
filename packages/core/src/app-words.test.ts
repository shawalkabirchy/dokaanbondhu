import { describe, expect, it } from "vitest";
import { appWord, isAppWordValue, priceLevelIn, priceTierOf } from "./app-words";

// A shop app's own words for price levels and a part's quality, position and unit (D121, D122), however it writes
// them; what the list does not know is asked in setup. Every garage or wholesale word is the one paikari price (D145).

describe("app words", () => {
  it.each([
    ["garage", "paikari"],
    ["Garage", "paikari"],
    ["MECHANIC", "paikari"],
    ["Workshop", "paikari"],
    ["গ্যারেজ", "paikari"],
    ["মেকানিক", "paikari"],
    ["Garage price", "paikari"],
    ["wholesale", "paikari"],
    ["Dealer", "paikari"],
    ["Wholesale_Customer", "paikari"],
    ["পাইকারি", "paikari"],
    ["retail", "retail"],
    ["Walk-In", "retail"],
    ["walk in customer", "retail"],
    ["Customer", "retail"],
    ["খুচরা", "retail"],
  ] as const)("reads the price level %s as %s", (value, tier) => {
    expect(priceTierOf(value)).toBe(tier);
  });

  it.each([
    ["OEM", "genuine"],
    ["Genuine", "genuine"],
    ["Original", "genuine"],
    ["Copy", "aftermarket"],
    ["China", "aftermarket"],
    ["Non-Genuine", "aftermarket"],
    ["Recon", "reconditioned"],
    ["Used", "used"],
    ["Second Hand", "used"],
    ["OEM grade", "genuine"],
  ] as const)("reads the quality %s as %s", (value, quality) => {
    expect(appWord("quality", value)).toBe(quality);
  });

  it.each([
    ["F", "front"],
    ["Front", "front"],
    ["FRT", "front"],
    ["Rear", "rear"],
    ["Back", "rear"],
    ["LH", "left"],
    ["RH", "right"],
    ["FL", "front left"],
    ["Front-Left", "front left"],
    ["Front Right", "front right"],
    ["RR", "rear right"],
    ["সামনের", "front"],
  ] as const)("reads the position %s as %s", (value, position) => {
    expect(appWord("position", value)).toBe(position);
  });

  it.each([
    ["pcs", "piece"],
    ["Nos", "piece"],
    ["SET", "set"],
    ["Ltr", "liter"],
    ["Litre", "liter"],
    ["Pair", "pair"],
    ["Ctn", "box"],
  ] as const)("reads the unit %s as %s", (value, unit) => {
    expect(appWord("unit", value)).toBe(unit);
  });

  it("knows no code, no unknown word, no empty value, and not R, which may be rear or right", () => {
    for (const value of ["2", "B", "VIP", "price", "", "  ", null, undefined])
      expect(priceTierOf(value)).toBeNull();
    expect(appWord("position", "R")).toBeNull();
    expect(appWord("quality", "A grade")).toBeNull();
    expect(appWord("unit", "kg")).toBeNull();
  });

  it("takes only our own values as an owner's choice", () => {
    expect(isAppWordValue("position", "rear")).toBe(true);
    expect(isAppWordValue("position", "front left")).toBe(false);
    expect(isAppWordValue("quality", "OEM")).toBe(false);
  });
});

describe("the price level a question names (D141, D142)", () => {
  // Two prices only: the normal one and paikari; every trade word asks for paikari.
  it.each([
    "এক্সিওর অয়েল ফিল্টারের পাইকারি দাম কত?",
    "axio r oil filter er paikari dam koto?",
    "oil filter wholesale price koto",
    "এক্সিওর প্যাডের গ্যারেজের দাম কত?",
    "axio r pad er garage dam koto?",
    "ডিলার দাম কত",
    "dealer dam koto",
  ])("%s asks the paikari price", (text) => {
    expect(priceLevelIn(text)).toBe("paikari");
  });

  it.each([
    "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড আছে?",
    "axio 2014 er samner brake pad ache?",
    "এক্সিওর প্যাডের খুচরা দাম কত?",
    "axio r pad er khuchra dam koto?",
  ])("%s names no level: the normal price", (text) => {
    expect(priceLevelIn(text)).toBeNull();
  });

  it("does not take a word of a named customer for a level", () => {
    expect(priceLevelIn("নিউ ঢাকা গ্যারেজের প্যাড দাও", ["নিউ ঢাকা গ্যারেজের"])).toBeNull();
    expect(priceLevelIn("new dhaka garage er pad dao", ["new dhaka garage er"])).toBeNull();
  });
});
