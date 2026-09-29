import { buildDictionary } from "@dokaanbondhu/core";
import { describe, expect, it } from "vitest";
import type { Catalog } from "../host/catalog";
import { buildKeyterms, MAX_KEYTERMS } from "./keyterms";

// Speech-recognition keyterms (spec 10.4, D99), on a small catalog.

const dictionary = buildDictionary();
const part = (hostId: string, name: string, sold: number) => ({
  hostId,
  name,
  nameBn: null,
  partNumbers: [],
  attrs: { sold_30d: sold },
});
const vehicle = (hostId: string, model: string) => ({
  hostId,
  make: "Toyota",
  model,
  yearFrom: 2012,
  yearTo: 2017,
  engineCode: null,
  vehicleType: "car",
});
const catalog: Catalog = {
  syncedAt: null,
  parts: [
    part("p1", "Front brake pad set", 9),
    part("p2", "Front brake pad set", 4),
    part("p3", "Starter motor", 6),
    part("p4", "Fan belt", 1),
  ],
  vehicles: [vehicle("v1", "Noah"), vehicle("v2", "Noah"), vehicle("v3", "Axio")],
  customers: [
    { hostId: "c1", name: "Rahim Motors", nameBn: "রহিম মোটরস", attrs: { sales_30d: 12 } },
    { hostId: "c2", name: "Karim Auto", nameBn: null, attrs: { sales_30d: 30 } },
  ],
  suppliers: [],
};

describe("speech-recognition keyterms (spec 10.4)", () => {
  it("without a vehicle: the best-selling part types and the common models in turn, then garages, in Bangla", () => {
    const terms = buildKeyterms(catalog, dictionary, {});
    expect(terms.slice(0, 4)).toEqual(["ব্রেক প্যাড", "নোয়া", "সেলফ", "এক্সিও"]);
    expect(terms).toContain("ফ্যান বেল্ট");
    expect(terms.at(-1)).toBe("রহিম মোটরস"); // a garage with a Bangla name; Karim Auto has none
    expect(terms.every((term) => /[ঀ-৿]/.test(term))).toBe(true);
  });

  it("with a current vehicle: the part types, then that vehicle's names", () => {
    const terms = buildKeyterms(catalog, dictionary, {
      vehicle: { model: "Toyota Axio", year: 2014, engine: null },
    });
    expect(terms.slice(0, 3)).toEqual(["ব্রেক প্যাড", "সেলফ", "ফ্যান বেল্ট"]);
    expect(terms.slice(3)).toEqual(expect.arrayContaining(["এক্সিও"]));
    expect(terms).not.toContain("নোয়া");
  });

  it("gives at most 25 terms and leaves out part types the shop has none of", () => {
    const many: Catalog = {
      ...catalog,
      vehicles: Array.from({ length: 40 }, (_, i) =>
        vehicle(`v${i}`, ["Noah", "Axio", "Premio", "Fielder"][i % 4]!),
      ),
    };
    expect(buildKeyterms(many, dictionary, {}).length).toBeLessThanOrEqual(MAX_KEYTERMS);
    expect(buildKeyterms(catalog, dictionary, {})).not.toContain("রেডিয়েটর");
  });
});
