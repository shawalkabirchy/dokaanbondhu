import { describe, expect, it } from "vitest";
import { appWord, isAppWordValue, priceLevelIn, priceTierOf } from "./app-words";

// A shop app's own words for price levels and a part's quality, position and unit (D121, D122), however it writes
// them; what the list does not know is asked in setup.

describe("app words", () => {
  it.each([
    ["garage", "garage"],
    ["Garage", "garage"],
    ["MECHANIC", "garage"],
    ["Workshop", "garage"],
    ["গ্যারেজ", "garage"],
    ["মেকানিক", "garage"],
    ["Garage price", "garage"],
    ["wholesale", "wholesale"],
    ["Dealer", "wholesale"],
    ["Wholesale_Customer", "wholesale"],
    ["পাইকারি", "wholesale"],
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

describe("the price level a question names (D141)", () => {
  it.each([
    ["এক্সিওর অয়েল ফিল্টারের পাইকারি দাম কত?", "wholesale"],
    ["axio r oil filter er paikari dam koto?", "wholesale"],
    ["oil filter wholesale price koto", "wholesale"],
    ["এক্সিওর প্যাডের গ্যারেজের দাম কত?", "garage"],
    ["axio r pad er garage dam koto?", "garage"],
  ] as const)("%s names %s", (text, level) => {
    expect(priceLevelIn(text)).toBe(level);
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
