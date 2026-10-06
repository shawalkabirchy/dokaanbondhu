import { describe, expect, it } from "vitest";
import { priceTierOf } from "./tiers";

// A customer's price level however a shop app writes it (D121); what the list does not know is asked in setup.

describe("price levels", () => {
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
  ] as const)("reads %s as %s", (value, tier) => {
    expect(priceTierOf(value)).toBe(tier);
  });

  it("knows no code, no unknown word and no empty value", () => {
    for (const value of ["2", "B", "VIP", "price", "", "  ", null, undefined])
      expect(priceTierOf(value)).toBeNull();
  });
});
