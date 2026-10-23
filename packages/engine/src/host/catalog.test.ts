import { describe, expect, it } from "vitest";
import {
  appWordsOf,
  countsOf,
  customerTier,
  hostCounts,
  ourWord,
  toCatalog,
  yearsOf,
  type CatalogRow,
} from "./catalog";
import { testMap } from "./test-map";

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
    // Garage, wholesale and dealer words are all the one paikari price (D145).
    expect(customerTier({ price_tier: "Garage" })).toBe("paikari");
    expect(customerTier({ type: "MECHANIC" })).toBe("paikari"); // no tier stored: the type decides
    expect(customerTier({ price_tier: "খুচরা", type: "garage" })).toBe("retail");
    expect(customerTier({ price_tier: "B", type: "workshop" })).toBe("paikari"); // an unknown tier: the type decides
    expect(customerTier({ type: "Dealer" })).toBe("paikari");
    expect(customerTier({ type: "পাইকারি" })).toBe("paikari");
  });

  it("answers at retail when the value is unknown or missing, until the owner chooses its level", () => {
    expect(customerTier({ price_tier: "VIP" })).toBe("retail");
    expect(customerTier({})).toBe("retail");
    expect(customerTier(undefined)).toBe("retail");
    expect(customerTier({ price_tier: "VIP" }, { price_tier: { VIP: "paikari" } })).toBe("paikari");
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
      { value: "Garage", our: "paikari", decidedBy: "words", count: 2 },
      { value: "walk-in", our: "retail", decidedBy: "words", count: 1 },
    ]);
    expect(appWordsOf(catalog, "price_tier", { price_tier: { VIP: "paikari" } })[0]).toEqual({
      value: "Garage",
      our: "paikari",
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

  it("reads a car's years however the app writes them (D122)", () => {
    expect(yearsOf({ year_from: "2012", year_to: "2017" })).toEqual({ from: 2012, to: 2017 });
    expect(yearsOf({ year_from: 2012, year_to: null })).toEqual({ from: 2012, to: null }); // still made
    expect(yearsOf({ year_from: "2012-2017" })).toEqual({ from: 2012, to: 2017 });
    expect(yearsOf({ year_from: "2016-20" })).toEqual({ from: 2016, to: 2020 });
    expect(yearsOf({ year_from: "12 - 17" })).toEqual({ from: 2012, to: 2017 });
    expect(yearsOf({ year_from: "2018+" })).toEqual({ from: 2018, to: null });
    expect(yearsOf({ year_from: "2018 onwards" })).toEqual({ from: 2018, to: null });
    expect(yearsOf({ year_from: "2014" })).toEqual({ from: 2014, to: 2014 }); // one year, no year_to mapped
    expect(yearsOf({})).toEqual({ from: 0, to: null });
    expect(yearsOf({ year_from: "new" })).toEqual({ from: 0, to: null });
  });
});

describe("counting the app's names (D208)", () => {
  const counting = (dialect: "postgres" | "mysql") => {
    const sent: string[] = [];
    const run = async (query: { text: string }) => {
      sent.push(query.text);
      return [{ n: dialect === "mysql" ? 7 : "7" }]; // pg returns a count as text, mysql2 as a number
    };
    return { sent, run };
  };

  it("counts each mapped concept over the rows the catalog reads, and skips one not mapped", async () => {
    const { sent, run } = counting("postgres");
    expect(await hostCounts(run, testMap())).toEqual({ part: 7, vehicle: 7, customer: 7, supplier: 0 });
    expect(sent).toHaveLength(3); // no supplier in this app: nothing asked, as its copy has none
    const parts = sent[0]!;
    expect(parts).toMatch(/^SELECT COUNT\("x"\."id"\) AS "n" FROM "items" AS "x"/);
    // the part's own filters apply, as in readCatalog; the codes table (a child) is not joined, so no part counts twice
    expect(parts).toContain(`"x"."deleted_at" IS NULL`);
    expect(parts).not.toContain("item_codes");
  });

  it("writes the same counts for a MySQL app", async () => {
    const { sent, run } = counting("mysql");
    expect(await hostCounts(run, testMap("mysql"))).toEqual({
      part: 7,
      vehicle: 7,
      customer: 7,
      supplier: 0,
    });
    expect(sent[0]).toMatch(/^SELECT COUNT\(`x`\.`id`\) AS `n` FROM `items` AS `x`/);
  });

  it("gives the copy's own counts to compare with", () => {
    const catalog = toCatalog([customer("c1", {}), customer("c2", {})]);
    expect(countsOf(catalog)).toEqual({ part: 0, vehicle: 0, customer: 2, supplier: 0 });
  });
});
