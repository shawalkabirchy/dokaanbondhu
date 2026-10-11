import { buildDictionary } from "@dokaanbondhu/core";
import { describe, expect, it } from "vitest";
import type { LlmDelta, LlmProvider } from "../providers";
import type { Catalog } from "./catalog";
import { banglaSpellings, namesToCheck } from "./speech-check";

// The listening check's names (D102 A): the shop's car models and the part types it stocks, with their Bangla word,
// and Bangla words for a new host's names from the LLM.

const dictionary = buildDictionary();
const vehicle = (hostId: string, make: string, model: string) => ({
  hostId,
  make,
  model,
  yearFrom: 2012,
  yearTo: 2017,
  engineCode: null,
  vehicleType: "car",
});
const part = (hostId: string, name: string) => ({ hostId, name, nameBn: null, partNumbers: [], attrs: {} });

describe("names the listening check says", () => {
  it("takes each car model once and the part types the shop stocks, with their usual Bangla word", () => {
    const catalog: Catalog = {
      syncedAt: null,
      parts: [part("p1", "Front brake pad set"), part("p2", "Starter motor")],
      vehicles: [
        vehicle("v1", "Toyota", "Axio"),
        vehicle("v2", "Toyota", "Axio"),
        vehicle("v3", "Haval", "H6"),
      ],
      customers: [],
      suppliers: [],
    };
    const names = namesToCheck(catalog, dictionary);
    expect(names).toContainEqual({ concept: "vehicle_model", value: "Toyota Axio", spoken: "এক্সিও" });
    expect(names).toContainEqual({ concept: "vehicle_model", value: "Haval H6", spoken: null }); // a new host's car
    expect(names).toContainEqual({ concept: "part_type", value: "Brake Pad", spoken: "ব্রেক প্যাড" });
    expect(names).toContainEqual({ concept: "part_type", value: "Starter Motor", spoken: "সেলফ" });
    expect(names.filter((name) => name.value === "Toyota Axio")).toHaveLength(1);
    expect(names.find((name) => name.value === "Radiator")).toBeUndefined(); // not stocked
  });

  it("checks every supplier and the customers who buy most, with their Bangla name when the app has one (D155)", () => {
    const customers = Array.from({ length: 60 }, (_, index) => ({
      hostId: `c${index}`,
      name: `Garage ${index}`,
      nameBn: index === 59 ? "গ্যারেজ ৫৯" : null,
      attrs: { sales_30d: index },
    }));
    const catalog: Catalog = {
      syncedAt: null,
      parts: [],
      vehicles: [],
      customers,
      suppliers: [{ hostId: "s1", name: "Nawabpur Auto Parts Ltd.", nameBn: null }],
    };
    const names = namesToCheck(catalog, dictionary);
    expect(names).toContainEqual({ concept: "supplier", value: "Nawabpur Auto Parts Ltd.", spoken: null });
    const checked = names.filter((name) => name.concept === "customer");
    expect(checked).toHaveLength(50);
    expect(checked[0]).toEqual({ concept: "customer", value: "Garage 59", spoken: "গ্যারেজ ৫৯" }); // buys most
    expect(checked.some((name) => name.value === "Garage 0")).toBe(false);
  });

  it("asks the LLM for Bangla words of new names, and keeps only Bangla answers for names it asked about", async () => {
    const llm: LlmProvider = {
      id: "stub",
      external: false,
      async *stream(): AsyncIterable<LlmDelta> {
        yield { type: "start" };
        yield {
          type: "text",
          text: "Haval H6 = হ্যাভাল এইচ সিক্স\nChery Tiggo = Chery Tiggo\nOther = অন্য\n",
        };
        yield { type: "finish", reason: "stop" };
      },
    };
    const found = await banglaSpellings(["Haval H6", "Chery Tiggo"], [llm]);
    expect([...found]).toEqual([["Haval H6", "হ্যাভাল এইচ সিক্স"]]);
    expect(await banglaSpellings([], [llm])).toEqual(new Map());
  });
});
