import { buildDictionary, catalogEntries, GLOSSARY } from "@dokaanbondhu/core";
import { describe, expect, it } from "vitest";
import { toCatalog, type CatalogRow } from "./catalog";
import { carsInText, parsedFitments, yearsInText } from "./fitment-text";

// Fit read from a part's name and notes, for an app without a part-to-car table (D122).

const now = new Date("2026-10-07T00:00:00Z");
const dictionary = buildDictionary();

describe("fit read from names and notes", () => {
  it.each([
    ["Brake pad Axio/Fielder 2012-17", { from: 2012, to: 2017 }],
    ["Fits Axio 2012-2017", { from: 2012, to: 2017 }],
    ["Shock Absorber FL Tucson 2016-20", { from: 2016, to: 2020 }],
    ["for Noah 2014 to 2021", { from: 2014, to: 2021 }],
    ["Prius 2018+", { from: 2018, to: null }],
    ["Vitz 2015", { from: 2015, to: 2015 }],
    ["Engine Oil 5W-30 4L", { from: null, to: null }],
    ["Toyota 04465-12610", { from: null, to: null }],
  ] as const)("reads the years in %s", (text, years) => {
    expect(yearsInText(text, now)).toEqual(years);
  });

  it("finds the cars a name mentions, and never a short spelling alone", () => {
    expect(carsInText("AC Compressor Axio/Fielder 2012-17", dictionary).sort()).toEqual([
      "Toyota Axio",
      "Toyota Fielder",
    ]);
    expect(carsInText("Fits Axio 2012-2017", dictionary)).toEqual(["Toyota Axio"]);
    expect(carsInText("Fit for any car", dictionary)).toEqual([]); // "fit" is Honda Fit only with "honda"
    expect(carsInText("Honda Fit 2015 bumper", dictionary)).toEqual(["Honda Fit"]);
    expect(carsInText("Engine Oil 5W-30 4L", dictionary)).toEqual([]);
  });

  it("reads the parts the app's own table does not cover, the app's own cars too, never verified", () => {
    const part = (hostId: string, name: string, notes: string | null = null): CatalogRow => ({
      concept: "part",
      hostId,
      displayName: name,
      displayNameBn: null,
      partNumbers: [],
      attrs: { notes },
    });
    const car = (hostId: string, model: string): CatalogRow => ({
      concept: "vehicle",
      hostId,
      displayName: model,
      displayNameBn: null,
      partNumbers: null,
      attrs: { model, year_from: "2016-2020" },
    });
    const catalog = toCatalog([
      part("p1", "Brake pad F Axio 2012-17"), // covered by the app's table: left alone
      part("p2", "AC Compressor Axio/Fielder 2012-17"),
      part("p3", "Power Steering Pump", "Fits Axio 2012-2017"),
      part("p4", "Shock Absorber Tucson 2016-20"),
      part("p5", "Engine Oil 5W-30 4L"),
      car("v1", "Tucson"),
    ]);
    const shop = buildDictionary([...GLOSSARY, ...catalogEntries(catalog)]);
    const rows = parsedFitments(catalog, shop, new Set(["p1"]), now);
    expect(rows.map((row) => `${row.hostPartId} ${row.model} ${row.yearFrom}-${row.yearTo}`).sort()).toEqual([
      "p2 Toyota Axio 2012-2017",
      "p2 Toyota Fielder 2012-2017",
      "p3 Toyota Axio 2012-2017",
      "p4 Tucson 2016-2020",
    ]);
    expect(rows.every((row) => !row.verified && row.source === "parsed")).toBe(true);
  });
});
