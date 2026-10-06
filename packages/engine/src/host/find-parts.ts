import {
  isModel,
  matchConcept,
  matchPartNumber,
  matchVehicles,
  normalize,
  pairedType,
  parseEngineCode,
  parseYear,
  partsOfType,
  positionsOf,
  roundTaka,
  type CatalogVehicle,
  type Dictionary,
  type PartRow,
} from "@dokaanbondhu/core";
import { ourWord, type AppWords, type Catalog } from "./catalog";
import type { Row, RunQuery } from "./pool";
import { hasField, type SchemaMap } from "./schema-map";
import { buildQuery, type Condition, type SelectItem } from "./sql";

// find_parts (spec 11.5): the part type and vehicle resolved through the glossary and the catalog, one generated
// query over the mapped part, fitment, stock and price tables, DokaanBondhu's own fitment_extra and rack_extra rows
// merged (marked unverified where they are), money read as whole taka (D110), then the part-type pair and the offers.
// Fitment is never asserted without a row.

/** The tool's arguments, all strings as said (spec 9.6). */
export interface PartQuery {
  part_type?: string;
  vehicle?: string;
  year?: string;
  engine?: string;
  position?: string;
  quality?: string;
  brand?: string;
  part_number?: string;
}

export interface FitmentExtra {
  hostPartId: string;
  make: string;
  model: string;
  yearFrom: number | null;
  yearTo: number | null;
  engineCode: string | null;
  verified: boolean;
}

export interface FindPartsInput {
  query: PartQuery;
  /** The other N-best hypotheses, rank order (empty for chat). */
  hypotheses: string[];
  map: SchemaMap;
  run: RunQuery;
  catalog: Catalog;
  dictionary: Dictionary;
  fitmentExtra: FitmentExtra[];
  rackExtra: ReadonlyMap<string, string>;
  /** The owner's choices for the app's own words (D121, D122). */
  appWords?: AppWords;
  now?: Date;
}

export interface Resolved {
  partType: string | null;
  vehicle: string | null;
  year: number | null;
  engine: string | null;
  position: string | null;
  quality: string | null;
  brand: string | null;
  /** Values understood with a medium score: shown in bold in a confirmation (spec 10.3). */
  bold: string[];
}

export type FindPartsResult =
  | {
      kind: "rows";
      rows: PartRow[];
      resolved: Resolved;
      pairUsed: string | null;
      /** The asked quality or brand that none of these rows has: the answer says so, then lists them (D95). */
      unmet?: "quality" | "brand";
    }
  | {
      kind: "ask";
      slot: "part_type" | "vehicle" | "year" | "part_number";
      options: string[];
      resolved: Resolved;
    }
  | { kind: "none"; resolved: Resolved; closeVehicle: PartRow[]; mentioned: PartRow[] };

const ROW_LIMIT = 20;

const QUALITY_ORDER = ["genuine", "aftermarket", "reconditioned"];

/** Kinds in a fixed order, so an answer never changes with the host's row order: genuine, non-genuine, reconditioned,
 * then the rest, each by name (D94). */
function ordered(rows: PartRow[]): PartRow[] {
  const rank = (row: PartRow) => {
    const index = QUALITY_ORDER.indexOf((row.quality ?? "").toLowerCase());
    return index < 0 ? QUALITY_ORDER.length : index;
  };
  return [...rows].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.hostPartId.localeCompare(b.hostPartId),
  );
}
const FETCH_LIMIT = 200;

/**
 * A host money value (text, exact) in whole taka: every connected app keeps money in taka (D110), and a fraction
 * ("1990.50") is rounded to the taka, half away from zero.
 */
export function toTaka(value: unknown): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const taka = roundTaka(BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length));
  return sign === "-" ? -taka : taka;
}

/** A host quantity as a number of units (3 decimals kept). */
export function toUnits(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : null;
}

function understood(
  concept: Parameters<typeof matchConcept>[0],
  said: string | undefined,
  input: FindPartsInput,
  bold: string[],
) {
  if (!said) return { value: null as string | null, unclear: false, options: [] as string[] };
  const match = matchConcept(concept, said, input.hypotheses, input.dictionary);
  const best = match.candidates[0];
  if (!best || match.decision === "unclear") {
    return {
      value: null,
      unclear: true,
      options: match.candidates.slice(0, 3).map((candidate) => candidate.value),
    };
  }
  if (match.decision === "understood_bold") bold.push(concept);
  return { value: best.value, unclear: false, options: [] };
}

/**
 * A row's value against the asked one. Quality and position are ours already (D122), and a position may be two
 * ("front left" is front and left); a brand is matched through the glossary.
 */
function sameValue(
  concept: "position" | "quality" | "brand",
  hostValue: string | null,
  wanted: string,
  dictionary: Dictionary,
): boolean {
  if (!hostValue) return false;
  if (hostValue.toLowerCase() === wanted.toLowerCase()) return true;
  if (concept === "position") return positionsOf(hostValue).includes(wanted);
  if (concept === "quality") return false;
  const match = matchConcept(concept, hostValue, [], dictionary);
  return match.candidates[0]?.exact === true && match.candidates[0].value === wanted;
}

function vehicleLabel(vehicle: CatalogVehicle): string {
  return `${vehicle.yearFrom}-${vehicle.yearTo ?? ""}`;
}

/** Runs the part query for part IDs, optionally through the fitments of the given vehicles. */
async function queryRows(
  input: FindPartsInput,
  partIds: string[],
  vehicleIds: string[] | null,
): Promise<PartRow[]> {
  const { map } = input;
  const part = (field: string, as = field): SelectItem[] =>
    hasField(map, "Part", field) ? [{ ref: { alias: "p", field }, as }] : [];
  const stock = (field: string, as: string): SelectItem[] =>
    hasField(map, "StockItem", field) && hasField(map, "StockItem", "part_id")
      ? [{ ref: { alias: "s", field }, as }]
      : [];
  const price = (field: string): SelectItem[] =>
    hasField(map, "Price", field) && hasField(map, "Price", "part_id")
      ? [{ ref: { alias: "pr", field }, as: field }]
      : [];
  const select: SelectItem[] = [
    { ref: { alias: "p", field: "id" }, as: "part_id" },
    { ref: { alias: "p", field: "name" }, as: "name" },
    ...part("name_bn"),
    ...part("quality"),
    ...part("position"),
    ...part("unit"),
    ...part("brand"),
    ...stock("quantity", "stock"),
    ...stock("rack_location", "rack"),
    ...price("retail_price"),
    ...price("garage_price"),
    ...price("wholesale_price"),
  ];
  const joins = [];
  const where: Condition[] = [{ ref: { alias: "p", field: "id" }, op: "in", values: partIds }];
  if (vehicleIds) {
    joins.push({
      entity: { concept: "Fitment" as const, alias: "f" },
      kind: "inner" as const,
      on: [{ left: { alias: "f", field: "part_id" }, right: { alias: "p", field: "id" } }],
    });
    select.push({ ref: { alias: "f", field: "vehicle_id" }, as: "vehicle_id" });
    if (hasField(map, "Fitment", "verified"))
      select.push({ ref: { alias: "f", field: "verified" }, as: "verified" });
    where.push({ ref: { alias: "f", field: "vehicle_id" }, op: "in", values: vehicleIds });
  }
  if (select.some((item) => item.ref.alias === "s")) {
    joins.push({
      entity: { concept: "StockItem" as const, alias: "s" },
      kind: "left" as const,
      on: [{ left: { alias: "s", field: "part_id" }, right: { alias: "p", field: "id" } }],
    });
  }
  if (select.some((item) => item.ref.alias === "pr")) {
    joins.push({
      entity: { concept: "Price" as const, alias: "pr" },
      kind: "left" as const,
      on: [{ left: { alias: "pr", field: "part_id" }, right: { alias: "p", field: "id" } }],
    });
  }
  const built = buildQuery(map, {
    from: { concept: "Part", alias: "p" },
    joins,
    select,
    where,
    limit: FETCH_LIMIT,
  });
  const rows: Row[] = await input.run(built);
  const vehicles = new Map(input.catalog.vehicles.map((vehicle) => [vehicle.hostId, vehicle]));
  return rows.map((row): PartRow => {
    const vehicle = row.vehicle_id !== undefined ? vehicles.get(String(row.vehicle_id)) : undefined;
    const hostPartId = String(row.part_id);
    return {
      hostPartId,
      name: String(row.name),
      nameBn: (row.name_bn as string | null) ?? null,
      // The app's own words as ours ("OEM" is genuine, "F" front, "pcs" piece; D122); an unknown word as written.
      quality: ourWord("quality", row.quality, input.appWords),
      position: ourWord("position", row.position, input.appWords),
      brand: (row.brand as string | null) ?? null,
      unit: ourWord("unit", row.unit, input.appWords),
      stock: toUnits(row.stock),
      retailTaka: toTaka(row.retail_price),
      garageTaka: toTaka(row.garage_price),
      wholesaleTaka: toTaka(row.wholesale_price),
      rack: (row.rack as string | null) ?? input.rackExtra.get(hostPartId) ?? null,
      fitmentVerified: vehicleIds
        ? row.verified === undefined || row.verified === true || row.verified === "true" || row.verified === 1
        : false,
      ...(vehicle
        ? {
            vehicle: {
              hostId: vehicle.hostId,
              yearFrom: vehicle.yearFrom,
              yearTo: vehicle.yearTo,
              engineCode: vehicle.engineCode,
            },
          }
        : {}),
    };
  });
}

/** Owner-added and parsed fitments for the vehicle, as rows marked unverified unless the owner verified them. */
async function extraRows(
  input: FindPartsInput,
  partIds: string[],
  model: string,
  year: number | null,
  engine: string | null,
) {
  const matching = input.fitmentExtra.filter(
    (extra) =>
      partIds.includes(extra.hostPartId) &&
      isModel(extra, model) &&
      (year === null || ((extra.yearFrom ?? 0) <= year && year <= (extra.yearTo ?? 9999))) &&
      (!engine || !extra.engineCode || extra.engineCode.toUpperCase().startsWith(engine)),
  );
  if (!matching.length) return [];
  const rows = await queryRows(input, [...new Set(matching.map((extra) => extra.hostPartId))], null);
  return rows.map((row) => ({
    ...row,
    fitmentVerified: matching.some((extra) => extra.hostPartId === row.hostPartId && extra.verified),
  }));
}

/**
 * The model year: its own argument, or else said with the car ("এক্সিও ২০১৪", "axio dui hajar choddo"), as in the
 * answer to "কোন গাড়ির?" or a tool call that put both in the vehicle (D108). A year that is part of the model's own
 * name is not one.
 */
function yearOf(query: PartQuery, model: string, now: Date | undefined): number | null {
  const own = query.year ? parseYear(normalize(query.year).tokens, { now, bare: true }) : null;
  if (own !== null || !query.vehicle) return own;
  const withCar = parseYear(normalize(query.vehicle).tokens, { now });
  return withCar !== null && !model.includes(String(withCar)) ? withCar : null;
}

export async function findParts(input: FindPartsInput): Promise<FindPartsResult> {
  const { query, catalog, dictionary } = input;
  const bold: string[] = [];
  const resolved: Resolved = {
    partType: null,
    vehicle: null,
    year: null,
    engine: null,
    position: null,
    quality: null,
    brand: null,
    bold,
  };

  // A part number: an exact match is used, a near one only offered.
  if (query.part_number) {
    const known = catalog.parts.flatMap((part) => part.partNumbers);
    const match = matchPartNumber(query.part_number, known);
    if (!match.exact) return { kind: "ask", slot: "part_number", options: match.offered, resolved };
    const ids = catalog.parts
      .filter((part) => part.partNumbers.includes(match.exact!))
      .map((part) => part.hostId);
    // Said with a car ("will AN-220WK fit a 2011 Sylphy?"): only fitment recorded for that car counts; otherwise the
    // answer is "not recorded for this car", never one that sounds like a fit (D94).
    const car = query.vehicle ? understood("vehicle_model", query.vehicle, input, bold) : null;
    if (car?.value) {
      resolved.partType = match.exact;
      resolved.vehicle = car.value;
      resolved.year = yearOf(query, car.value, input.now);
      resolved.engine = query.engine ? parseEngineCode(normalize(query.engine).tokens) : null;
      const vehicles = matchVehicles(car.value, resolved.year, resolved.engine, catalog.vehicles);
      if (vehicles.needsYear) {
        return { kind: "ask", slot: "year", options: vehicles.vehicles.map(vehicleLabel), resolved };
      }
      const recorded = vehicles.vehicles.length
        ? await queryRows(
            input,
            ids,
            vehicles.vehicles.map((vehicle) => vehicle.hostId),
          )
        : [];
      const extra = await extraRows(input, ids, car.value, resolved.year, resolved.engine);
      const seen = new Set(recorded.map((row) => row.hostPartId));
      const fitting = [...recorded, ...extra.filter((row) => !seen.has(row.hostPartId))];
      if (fitting.length) {
        return { kind: "rows", rows: ordered(fitting).slice(0, ROW_LIMIT), resolved, pairUsed: null };
      }
      const itself = await queryRows(input, ids, null);
      return { kind: "none", resolved, closeVehicle: [], mentioned: ordered(itself).slice(0, ROW_LIMIT) };
    }
    const rows = await queryRows(input, ids, null);
    return { kind: "rows", rows: ordered(rows).slice(0, ROW_LIMIT), resolved, pairUsed: null };
  }

  const type = understood("part_type", query.part_type, input, bold);
  if (type.unclear || !type.value) return { kind: "ask", slot: "part_type", options: type.options, resolved };
  resolved.partType = type.value;
  const model = understood("vehicle_model", query.vehicle, input, bold);
  if (model.unclear || !model.value)
    return { kind: "ask", slot: "vehicle", options: model.options, resolved };
  resolved.vehicle = model.value;
  resolved.year = yearOf(query, model.value, input.now);
  resolved.engine = query.engine ? parseEngineCode(normalize(query.engine).tokens) : null;
  for (const slot of ["position", "quality", "brand"] as const) {
    const value = understood(slot, query[slot], input, bold);
    resolved[slot] = value.value;
  }

  const vehicles = matchVehicles(model.value, resolved.year, resolved.engine, catalog.vehicles);
  if (vehicles.needsYear) {
    return { kind: "ask", slot: "year", options: vehicles.vehicles.map(vehicleLabel), resolved };
  }

  const tryType = async (partType: string) => {
    const ids = partsOfType(partType, catalog.parts, dictionary).map((part) => part.hostId);
    if (!ids.length) return { exact: [] as PartRow[], placed: [] as PartRow[] };
    const recorded = vehicles.vehicles.length
      ? await queryRows(
          input,
          ids,
          vehicles.vehicles.map((vehicle) => vehicle.hostId),
        )
      : [];
    const extra = await extraRows(input, ids, model.value!, resolved.year, resolved.engine);
    const seen = new Set(recorded.map((row) => row.hostPartId));
    const merged = [...recorded, ...extra.filter((row) => !seen.has(row.hostPartId))];
    const placed = merged.filter(
      (row) => !resolved.position || sameValue("position", row.position, resolved.position, dictionary),
    );
    const exact = placed.filter(
      (row) =>
        (!resolved.quality || sameValue("quality", row.quality, resolved.quality, dictionary)) &&
        (!resolved.brand || sameValue("brand", row.brand, resolved.brand, dictionary)),
    );
    return { exact, placed };
  };

  let found = await tryType(type.value);
  let pairUsed: string | null = null;
  if (!found.placed.length) {
    const pair = pairedType(type.value);
    if (pair) {
      found = await tryType(pair);
      if (found.placed.length) pairUsed = pair;
    }
  }
  const rows = found.exact;
  if (rows.length) return { kind: "rows", rows: ordered(rows).slice(0, ROW_LIMIT), resolved, pairUsed };
  // The part is there for this car, but not in the asked quality or brand: say that, then list what there is.
  if (found.placed.length && (resolved.quality || resolved.brand)) {
    const unmet = resolved.quality ? ("quality" as const) : ("brand" as const);
    return { kind: "rows", rows: ordered(found.placed).slice(0, ROW_LIMIT), resolved, pairUsed, unmet };
  }

  // None: recorded fitment for a close vehicle (the same model's other generations), and items whose notes
  // mention the vehicle, both marked unverified (architecture, resolution algorithm, step 5).
  const ids = partsOfType(type.value, catalog.parts, dictionary).map((part) => part.hostId);
  const others = catalog.vehicles.filter(
    (vehicle) =>
      isModel(vehicle, model.value!) && !vehicles.vehicles.some((wanted) => wanted.hostId === vehicle.hostId),
  );
  const closeVehicle =
    ids.length && others.length
      ? await queryRows(
          input,
          ids,
          others.map((vehicle) => vehicle.hostId),
        )
      : [];
  let mentioned: PartRow[] = [];
  if (ids.length && hasField(input.map, "Part", "notes")) {
    const word = model.value.split(" ").slice(-1)[0] ?? model.value;
    const built = buildQuery(input.map, {
      from: { concept: "Part", alias: "p" },
      select: [{ ref: { alias: "p", field: "id" }, as: "part_id" }],
      where: [
        { ref: { alias: "p", field: "id" }, op: "in", values: ids },
        { ref: { alias: "p", field: "notes" }, op: "contains", value: word },
      ],
      limit: ROW_LIMIT,
    });
    const found = (await input.run(built)).map((row) => String(row.part_id));
    mentioned = found.length
      ? (await queryRows(input, found, null)).map((row) => ({ ...row, fitmentVerified: false }))
      : [];
  }
  return {
    kind: "none",
    resolved,
    closeVehicle: closeVehicle.map((row) => ({ ...row, fitmentVerified: false })),
    mentioned,
  };
}
