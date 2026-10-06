import { describe, expect, it } from "vitest";
import { buildDictionary, GLOSSARY, matchConcept } from "./glossary";
import { partsOfType, type CatalogPart, type CatalogVehicle } from "./resolve";
import { catalogEntries } from "./shop-words";

// The shop's own vocabulary from its app's data (D122): car models, categories and part kinds the glossary lacks.

const car = (hostId: string, make: string, model: string): CatalogVehicle => ({
  hostId,
  make,
  model,
  yearFrom: 2012,
  yearTo: 2017,
  engineCode: null,
  vehicleType: null,
});
const part = (hostId: string, name: string, category: string | null = null): CatalogPart => ({
  hostId,
  name,
  nameBn: null,
  partNumbers: [],
  category,
});

const catalog = {
  vehicles: [
    car("v1", "", "Axio NZE141"), // the glossary's Toyota Axio
    car("v2", "", "Tucson"),
    car("v3", "Toyota", "Crown GRS180"),
    car("v4", "Bajaj", "Pulsar 150"),
    car("v5", "Haval", "H6"), // a model's own name, not a code
    car("v6", "", "RAV4"), // the glossary's Toyota RAV4
  ],
  parts: [
    part("p1", "Toyota 04465-12610", "Brake Pads"),
    part("p2", "Brake Shoe R", "Brakes"),
    part("p3", "AC Compressor Axio/Fielder 2012-17", "AC Compressor"),
    part("p4", "Brake master cylinder repair kit"),
    part("p5", "Engine Oil 5W-30 4L"),
    part("p6", "Rust remover spray 450ml"),
    part("p7", "Toyota 90919-01253"),
  ],
};
const entries = catalogEntries(catalog);
const dictionary = buildDictionary([...GLOSSARY, ...entries]);
const values = (concept: string) =>
  [
    ...new Set(
      entries.filter((entry) => entry.target_concept === concept).map((entry) => entry.target_value),
    ),
  ].sort();

describe("the shop's own vocabulary", () => {
  it("adds the cars the glossary lacks, without codes, and with a short name; known cars stay the glossary's", () => {
    expect(values("vehicle_model")).toEqual(["Bajaj Pulsar 150", "Haval H6", "Toyota Crown", "Tucson"]);
    for (const said of ["tucson", "toyota crown", "crown", "pulsar 150", "pulsar"]) {
      expect(matchConcept("vehicle_model", said, [], dictionary).candidates[0]).toMatchObject({
        exact: true,
      });
    }
  });

  it("adds categories and the part kind of names naming no type; a plural is the glossary's, a sound alike is not", () => {
    // As the app writes them.
    expect(values("part_type")).toEqual([
      "AC Compressor",
      "Brake Pad", // "Brake Pads" is another spelling of it
      "Brake master cylinder",
      "Brakes", // not Brake Shoe, however alike it sounds
      "Rust remover spray",
    ]);
    expect(entries).toContainEqual({
      target_concept: "part_type",
      target_value: "Brake Pad",
      bn: [],
      latin: ["brake pads"],
    });
  });

  it("finds a part by its category as well as its name", () => {
    expect(partsOfType("Brake Pad", catalog.parts, dictionary).map((found) => found.hostId)).toEqual(["p1"]);
    expect(partsOfType("AC Compressor", catalog.parts, dictionary).map((found) => found.hostId)).toEqual([
      "p3",
    ]);
    expect(
      partsOfType("Brake master cylinder", catalog.parts, dictionary).map((found) => found.hostId),
    ).toEqual(["p4"]);
  });

  it("understands the shop's own kinds, typed as the app writes them", () => {
    for (const said of ["ac compressor", "brake master cylinder", "rust remover spray"]) {
      expect(matchConcept("part_type", said, [], dictionary)).toMatchObject({ decision: "understood" });
    }
  });
});
