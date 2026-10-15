import { describe, expect, it } from "vitest";
import { buildDictionary, GLOSSARY } from "./glossary";
import {
  isModel,
  matchVehicles,
  pairedType,
  partsOfType,
  resolveCustomer,
  separatingSlot,
  yearRanges,
  type CatalogCustomer,
  type CatalogPart,
  type CatalogVehicle,
  type PartRow,
} from "./resolve";

const dictionary = buildDictionary();

const vehicle = (fields: Partial<CatalogVehicle> & { hostId: string }): CatalogVehicle => ({
  make: "Toyota",
  model: "Axio",
  yearFrom: 2012,
  yearTo: 2017,
  engineCode: null,
  vehicleType: null,
  ...fields,
});

const vehicles: CatalogVehicle[] = [
  {
    hostId: "v1",
    make: "Toyota",
    model: "Axio",
    yearFrom: 2006,
    yearTo: 2011,
    engineCode: "1NZ",
    vehicleType: "car",
  },
  {
    hostId: "v2",
    make: "Toyota",
    model: "Axio",
    yearFrom: 2012,
    yearTo: 2017,
    engineCode: "1NZ",
    vehicleType: "car",
  },
  {
    hostId: "v3",
    make: "Toyota",
    model: "Noah",
    yearFrom: 2014,
    yearTo: 2021,
    engineCode: "3ZR",
    vehicleType: "microbus",
  },
];

const parts: CatalogPart[] = [
  {
    hostId: "p1",
    name: "Front brake pad set",
    nameBn: "সামনের ব্রেক প্যাড সেট",
    partNumbers: ["04465-10010"],
  },
  { hostId: "p2", name: "Rear brake shoe set", nameBn: null, partNumbers: ["AN-108WK"] },
  { hostId: "p3", name: "Starter motor", nameBn: "সেলফ মোটর", partNumbers: ["28100-10010"] },
  { hostId: "p4", name: "Oil filter", nameBn: null, partNumbers: ["90915-10010"] },
];

function row(overrides: Partial<PartRow>): PartRow {
  return {
    hostPartId: "x",
    name: "Front brake pad set",
    nameBn: null,
    quality: "genuine",
    position: "front",
    brand: "Toyota",
    unit: "set",
    stock: 3,
    retailTaka: 4500n,
    garageTaka: 4200n,
    wholesaleTaka: null,
    rack: "B-3",
    fitmentVerified: true,
    ...overrides,
  };
}

describe("part resolver (spec 10.7)", () => {
  it("finds the parts of a type by their English or Bangla names", () => {
    expect(partsOfType("Brake Pad", parts, dictionary).map((part) => part.hostId)).toEqual(["p1"]);
    expect(partsOfType("Starter Motor", parts, dictionary).map((part) => part.hostId)).toEqual(["p3"]);
    expect(partsOfType("Oil Filter", parts, dictionary).map((part) => part.hostId)).toEqual(["p4"]);
  });

  it("matches the vehicle by model and year range, and asks the year when generations differ", () => {
    expect(matchVehicles("Toyota Axio", 2014, null, vehicles).vehicles.map((v) => v.hostId)).toEqual(["v2"]);
    expect(matchVehicles("Toyota Axio", null, null, vehicles)).toMatchObject({ needsYear: true });
    expect(matchVehicles("Toyota Noah", null, null, vehicles)).toMatchObject({ needsYear: false });
    expect(matchVehicles("Toyota Axio", 2014, "3ZR", vehicles).vehicles).toEqual([]);
  });

  // D122: apps write cars their own way: no make column, a chassis code, a combined name, another make.
  it.each([
    [{ make: "Toyota", model: "Axio" }, "Toyota Axio", true],
    [{ make: "", model: "Axio" }, "Toyota Axio", true],
    [{ make: "", model: "Axio NZE141" }, "Toyota Axio", true],
    [{ make: "TOYOTA", model: "AXIO" }, "Toyota Axio", true],
    [{ make: "", model: "Toyota Axio" }, "Toyota Axio", true],
    [{ make: "Toyota", model: "Corolla Axio" }, "Toyota Axio", true],
    [{ make: "", model: "Noah/Voxy" }, "Toyota Noah", true],
    [{ make: "", model: "Sylphy" }, "Nissan Bluebird Sylphy", true],
    [{ make: "", model: "Tucson" }, "Tucson", true],
    [{ make: "Honda", model: "Axio" }, "Toyota Axio", false],
    [{ make: "", model: "Fielder" }, "Toyota Axio", false],
    [{ make: "", model: "Alto" }, "Toyota Axio", false],
  ] as const)("matches %o as %s: %s", (vehicle, wanted, expected) => {
    expect(isModel(vehicle, wanted)).toBe(expected);
  });

  it("finds an app's cars without a make column, asking the year when two generations match", () => {
    const noMake = [
      vehicle({ hostId: "n1", make: "", model: "Axio NZE141", yearFrom: 2012, yearTo: 2017 }),
      vehicle({ hostId: "n2", make: "", model: "Axio", yearFrom: 2006, yearTo: 2011 }),
    ];
    expect(matchVehicles("Toyota Axio", 2014, null, noMake).vehicles.map((v) => v.hostId)).toEqual(["n1"]);
    expect(matchVehicles("Toyota Axio", null, null, noMake)).toMatchObject({ needsYear: true });
  });

  // D167: a year button picks exactly its car rows; the year is asked only between different years, each once.
  it("picks a year button's car rows exactly, also where two generations share a year", () => {
    const fielders = [
      vehicle({ hostId: "f1", model: "Fielder", yearFrom: 2006, yearTo: 2012 }),
      vehicle({ hostId: "f2", model: "Fielder", yearFrom: 2012, yearTo: 2017 }),
    ];
    const ids = (match: { vehicles: { hostId: string }[] }) => match.vehicles.map((v) => v.hostId);
    expect(ids(matchVehicles("Toyota Fielder", 2012, null, fielders))).toEqual(["f1", "f2"]);
    expect(ids(matchVehicles("Toyota Fielder", 2012, null, fielders, { from: 2012, to: 2017 }))).toEqual([
      "f2",
    ]);
    expect(ids(matchVehicles("Toyota Fielder", 2006, null, fielders, { from: 2006, to: 2012 }))).toEqual([
      "f1",
    ]);
    expect(matchVehicles("Toyota Fielder", null, null, fielders)).toMatchObject({ needsYear: true });
    expect(yearRanges(fielders)).toEqual(["2006-2012", "2012-2017"]);
  });

  it("asks the year only when the car rows have different years, offering each years once", () => {
    // Shop B: two Axio chassis of the same years, and the older generation.
    const axios = [
      vehicle({ hostId: "a1", make: "", model: "Axio NZE141", yearFrom: 2012, yearTo: 2017 }),
      vehicle({ hostId: "a2", make: "", model: "Axio", yearFrom: 2006, yearTo: 2011 }),
      vehicle({ hostId: "a3", make: "", model: "Axio NZE144", yearFrom: 2012, yearTo: 2017 }),
    ];
    expect(yearRanges(axios)).toEqual(["2006-2011", "2012-2017"]);
    expect(
      matchVehicles("Toyota Axio", 2014, null, axios, { from: 2012, to: 2017 }).vehicles.map((v) => v.hostId),
    ).toEqual(["a1", "a3"]);
    // The same years twice, or no years at all (an app that keeps none): the parts tell them apart, not a year.
    const sameYears = [axios[0]!, axios[2]!];
    expect(matchVehicles("Toyota Axio", null, null, sameYears)).toMatchObject({ needsYear: false });
    const noYears = [
      vehicle({
        hostId: "p1",
        make: "Mitsubishi",
        model: "Pajero",
        yearFrom: 0,
        yearTo: null,
        engineCode: "4D56",
      }),
      vehicle({
        hostId: "p2",
        make: "Mitsubishi",
        model: "Pajero",
        yearFrom: 0,
        yearTo: null,
        engineCode: "4M40",
      }),
    ];
    expect(matchVehicles("Mitsubishi Pajero", null, null, noYears)).toMatchObject({ needsYear: false });
    expect(yearRanges(noYears)).toEqual([]);
    // A car row without years fits any year asked, and any year button.
    expect(matchVehicles("Mitsubishi Pajero", 2014, null, noYears).vehicles).toHaveLength(2);
    expect(
      matchVehicles("Mitsubishi Pajero", 2014, null, noYears, { from: 2012, to: 2017 }).vehicles,
    ).toHaveLength(2);
  });

  it("pairs brake pads with brake shoes", () => {
    expect(pairedType("Brake Pad")).toBe("Brake Shoe");
    expect(pairedType("Brake Shoe")).toBe("Brake Pad");
    expect(pairedType("Oil Filter")).toBeNull();
  });

  it("separates the remaining parts by the slot with the most distinct values, with price and stock", () => {
    const rows = [
      row({
        hostPartId: "a",
        quality: "genuine",
        brand: "Toyota",
        retailTaka: 4500n,
        garageTaka: 4200n,
        stock: 3,
      }),
      row({
        hostPartId: "b",
        quality: "aftermarket",
        brand: "Akebono",
        retailTaka: 2800n,
        garageTaka: 2600n,
        stock: 6,
      }),
    ];
    const separated = separatingSlot(rows, "paikari");
    expect(separated?.slot).toBe("quality"); // quality and brand tie; quality comes first
    expect(separated?.options).toMatchObject([
      { value: "genuine", priceTaka: 4200n, stock: 3 },
      { value: "aftermarket", priceTaka: 2600n, stock: 6 },
    ]);
    expect(separatingSlot([rows[0]!, row({ hostPartId: "c" })])).toBeNull();
  });

  // D167: an answered slot is never asked again in the request; a car without years is never a year button.
  it("leaves out the slots the request has answered, and cars without years", () => {
    const car = (yearFrom: number, yearTo: number | null) => ({
      hostId: `v${yearFrom}`,
      yearFrom,
      yearTo,
      engineCode: "1NZ",
    });
    const rows = [
      row({ hostPartId: "a", quality: "genuine", vehicle: car(2006, 2012) }),
      row({ hostPartId: "b", quality: "genuine", vehicle: car(2012, 2017) }),
      row({ hostPartId: "c", quality: "aftermarket", vehicle: car(2006, 2012) }),
    ];
    expect(separatingSlot(rows)?.slot).toBe("year");
    expect(separatingSlot(rows, "retail", new Set(["year"]))?.slot).toBe("quality");
    expect(separatingSlot(rows, "retail", new Set(["year", "quality"]))).toBeNull();
    const noYears = [
      row({ hostPartId: "d", vehicle: car(0, null) }),
      row({ hostPartId: "e", vehicle: { ...car(0, null), engineCode: "4M40" } }),
    ];
    expect(separatingSlot(noYears)?.slot).toBe("engine");
  });
});

describe("customer resolver (spec 10.7)", () => {
  const customers: CatalogCustomer[] = [
    { hostId: "c1", name: "Rahim Motors", nameBn: null },
    { hostId: "c2", name: "Rahim Auto Garage", nameBn: null },
    { hostId: "c3", name: "Karim Auto", nameBn: null },
  ];

  it.each(["রহিম", "rahim"])("asks when the spoken name begins several names (%s)", (name) => {
    const match = resolveCustomer(name, [], customers, dictionary);
    expect(match.decision).toBe("ambiguous");
    expect(
      match.candidates
        .map((candidate) => candidate.customer.name)
        .slice(0, 2)
        .sort(),
    ).toEqual(["Rahim Auto Garage", "Rahim Motors"]);
  });

  it("understands a full name, in Latin or Bangla script", () => {
    const latin = resolveCustomer("rahim motors", [], customers, dictionary);
    expect(latin.decision).toBe("understood");
    expect(latin.candidates[0]).toMatchObject({ customer: { hostId: "c1" }, score: 1 });
    const bangla = resolveCustomer("রহিম মোটরস", [], customers, dictionary);
    expect(bangla.decision).toBe("understood");
    expect(bangla.candidates[0]?.customer.hostId).toBe("c1");
    expect(resolveCustomer("করিম অটো", [], customers, dictionary).candidates[0]?.customer.hostId).toBe("c3");
  });

  it.each([
    ["নবাবপুর অটো পার্টস", "understood"],
    ["nawabpur auto parts", "understood"],
    ["Nawabpur Auto Parts Limited", "understood"],
    // As the speech service heard it on 9 Oct, in both scripts.
    ["নাওয়াবপুর অটোপার্স", "understood_bold"],
    ["nawabpur autopars", "understood_bold"],
  ] as const)("matches a name without its company ending, as people say it (D148): %s", (heard, decision) => {
    const suppliers: CatalogCustomer[] = [
      { hostId: "s1", name: "Nawabpur Auto Parts Ltd.", nameBn: null },
      { hostId: "s2", name: "Bangshal Motor Supply", nameBn: null },
    ];
    const match = resolveCustomer(heard, [], suppliers, dictionary);
    expect(match.decision).toBe(decision);
    expect(match.candidates[0]?.customer.hostId).toBe("s1");
  });

  it.each([
    { style: "Bangla", spelling: { bn: ["নওয়াপুর অটোপাস"], latin: [] }, heard: "নওয়াপুর অটোপাস" },
    { style: "Banglish", spelling: { bn: [], latin: ["nowapur autopas"] }, heard: "nowapur autopas" },
  ])(
    "understands a name as speech-to-text writes it once the owner adds it (D155; $style)",
    ({ spelling, heard }) => {
      const suppliers: CatalogCustomer[] = [
        { hostId: "s1", name: "Nawabpur Auto Parts Ltd.", nameBn: null },
        { hostId: "s2", name: "Japan Auto Parts Importer", nameBn: null },
      ];
      expect(resolveCustomer(heard, [], suppliers, dictionary).decision).toBe("unclear");
      const learned = buildDictionary([
        ...GLOSSARY,
        { target_concept: "supplier", target_value: "Nawabpur Auto Parts Ltd.", ...spelling },
      ]);
      const match = resolveCustomer(heard, [], suppliers, learned);
      expect(match.decision).toBe("understood");
      expect(match.candidates[0]?.customer.hostId).toBe("s1");
    },
  );

  it("leaves an unknown name unclear", () => {
    expect(resolveCustomer("Jamal Traders", [], customers, dictionary).decision).toBe("unclear");
  });
});
