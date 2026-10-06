import { describe, expect, it } from "vitest";
import { appWord, isAppWordValue, priceTierOf } from "./app-words";

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
