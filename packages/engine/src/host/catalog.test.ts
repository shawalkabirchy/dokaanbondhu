import { describe, expect, it } from "vitest";
import { appWordsOf, customerTier, ourWord, toCatalog, type CatalogRow } from "./catalog";

// The app's own words (spec 9.8, D121, D122): a customer's price level is its own tier, else its type, and a part's
// quality, position and unit are read through the owner's choice and then the word list, so any shop app's wording
// works; an unknown price level is retail, and an unknown part word is kept as written.

const customer = (hostId: string, attrs: Record<string, unknown>): CatalogRow => ({
  concept: "customer",
  hostId,
  displayName: hostId,
  displayNameBn: null,
  partNumbers: null,
  attrs,
});

describe("customer price levels", () => {
  it("reads the tier or the type in any wording, the tier first", () => {
    expect(customerTier({ price_tier: "Garage" })).toBe("garage");
    expect(customerTier({ type: "MECHANIC" })).toBe("garage"); // no tier stored: the type decides
    expect(customerTier({ price_tier: "পাইকারি", type: "garage" })).toBe("wholesale");
    expect(customerTier({ price_tier: "B", type: "workshop" })).toBe("garage"); // an unknown tier: the type decides
    expect(customerTier({ type: "Dealer" })).toBe("wholesale");
  });

  it("answers at retail when the value is unknown or missing, until the owner chooses its level", () => {
    expect(customerTier({ price_tier: "VIP" })).toBe("retail");
    expect(customerTier({})).toBe("retail");
    expect(customerTier(undefined)).toBe("retail");
    expect(customerTier({ price_tier: "VIP" }, { price_tier: { VIP: "wholesale" } })).toBe("wholesale");
    expect(customerTier({ price_tier: "Garage" }, { price_tier: { Garage: "retail" } })).toBe("retail"); // the owner wins
    expect(customerTier({ price_tier: "VIP" }, { price_tier: { VIP: "nonsense" } })).toBe("retail");
  });

  it("lists each deciding value with its customers for setup, the unknown ones first", () => {
    const catalog = toCatalog([
      customer("c1", { price_tier: "Garage" }),
      customer("c2", { price_tier: "Garage" }),
      customer("c3", { price_tier: "VIP" }),
      customer("c4", { type: "walk-in" }),
      customer("c5", {}),
    ]);
    expect(appWordsOf(catalog, "price_tier", {})).toEqual([
      { value: "VIP", our: null, decidedBy: null, count: 1 },
      { value: "Garage", our: "garage", decidedBy: "words", count: 2 },
      { value: "walk-in", our: "retail", decidedBy: "words", count: 1 },
    ]);
    expect(appWordsOf(catalog, "price_tier", { price_tier: { VIP: "wholesale" } })[0]).toEqual({
      value: "Garage",
      our: "garage",
      decidedBy: "words",
      count: 2,
    });
  });

  it("reads a part's quality, position and unit in the app's words, and keeps an unknown word as written", () => {
    expect(ourWord("quality", "OEM")).toBe("genuine");
    expect(ourWord("position", "FL")).toBe("front left");
    expect(ourWord("unit", "pcs")).toBe("piece");
    expect(ourWord("position", "R")).toBe("R");
    expect(ourWord("position", "R", { position: { R: "rear" } })).toBe("rear");
    expect(ourWord("quality", null)).toBeNull();
    const part = (hostId: string, attrs: Record<string, unknown>): CatalogRow => ({
      concept: "part",
      hostId,
      displayName: hostId,
      displayNameBn: null,
      partNumbers: [],
      attrs,
    });
    const catalog = toCatalog([part("p1", { position: "F" }), part("p2", { position: "R" }), part("p3", {})]);
    expect(appWordsOf(catalog, "position", {})).toEqual([
      { value: "R", our: null, decidedBy: null, count: 1 },
      { value: "F", our: "front", decidedBy: "words", count: 1 },
    ]);
  });
});
