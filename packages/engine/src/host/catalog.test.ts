import { describe, expect, it } from "vitest";
import { customerTier, priceLevels, toCatalog, type CatalogRow } from "./catalog";

// A customer's price level (spec 9.8, D121): its own tier, else its type, each through the owner's choice and then the
// word list, so any shop app's wording works; retail when nobody has named the value yet.

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
    expect(customerTier({ price_tier: "VIP" }, { VIP: "wholesale" })).toBe("wholesale");
    expect(customerTier({ price_tier: "Garage" }, { Garage: "retail" })).toBe("retail"); // the owner wins
    expect(customerTier({ price_tier: "VIP" }, { VIP: "nonsense" })).toBe("retail");
  });

  it("lists each deciding value with its customers for setup, the unknown ones first", () => {
    const catalog = toCatalog([
      customer("c1", { price_tier: "Garage" }),
      customer("c2", { price_tier: "Garage" }),
      customer("c3", { price_tier: "VIP" }),
      customer("c4", { type: "walk-in" }),
      customer("c5", {}),
    ]);
    expect(priceLevels(catalog, {})).toEqual([
      { value: "VIP", tier: null, decidedBy: null, customers: 1 },
      { value: "Garage", tier: "garage", decidedBy: "words", customers: 2 },
      { value: "walk-in", tier: "retail", decidedBy: "words", customers: 1 },
    ]);
    expect(priceLevels(catalog, { VIP: "wholesale" })[0]).toEqual({
      value: "Garage",
      tier: "garage",
      decidedBy: "words",
      customers: 2,
    });
  });
});
