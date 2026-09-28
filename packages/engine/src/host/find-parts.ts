import {
  matchConcept,
  matchPartNumber,
  matchVehicles,
  normalize,
  pairedType,
  parseEngineCode,
  parseYear,
  partsOfType,
  type CatalogVehicle,
  type Dictionary,
  type PartRow,
} from "@dokaanbondhu/core";
import type { Catalog } from "./catalog";
import type { Row, RunQuery } from "./pool";
import { hasField, type SchemaMap } from "./schema-map";
import { buildQuery, type Condition, type SelectItem } from "./sql";

// find_parts (spec 11.5): the part type and vehicle resolved through the glossary and the catalog, one generated
// query over the mapped part, fitment, stock and price tables, DokaanBondhu's own fitment_extra and rack_extra rows
// merged (marked unverified where they are), the value scale applied, then the part-type pair and the offers.
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
  | { kind: "rows"; rows: PartRow[]; resolved: Resolved; pairUsed: string | null }
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

/** A host money value (text, exact) to paisa, using the field's value scale; half away from zero. */
export function toPaisa(value: unknown, valueScale: number): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const digits = BigInt(`${whole}${fraction}`);
  const denominator = 10n ** BigInt(fraction.length) * BigInt(valueScale);
  const numerator = digits * 100n;
  let paisa = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) paisa += 1n;
  return sign === "-" ? -paisa : paisa;
}

/** A host quantity to units, using the field's value scale (3 decimals kept). */
export function toUnits(value: unknown, valueScale: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round((number / valueScale) * 1000) / 1000 : null;
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

/** A host attribute value (front, OEM, ...) against a canonical one, through the glossary. */
function sameValue(
  concept: "position" | "quality" | "brand",
  hostValue: string | null,
  wanted: string,
  dictionary: Dictionary,
): boolean {
  if (!hostValue) return false;
  if (hostValue.toLowerCase() === wanted.toLowerCase()) return true;
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
  const scale = (as: string) => built.columns.find((column) => column.as === as)?.valueScale ?? 1;
  const rows: Row[] = await input.run(built);
  const vehicles = new Map(input.catalog.vehicles.map((vehicle) => [vehicle.hostId, vehicle]));
  return rows.map((row): PartRow => {
    const vehicle = row.vehicle_id !== undefined ? vehicles.get(String(row.vehicle_id)) : undefined;
    const hostPartId = String(row.part_id);
    return {
      hostPartId,
      name: String(row.name),
      nameBn: (row.name_bn as string | null) ?? null,
      quality: (row.quality as string | null) ?? null,
      position: (row.position as string | null) ?? null,
      brand: (row.brand as string | null) ?? null,
      unit: (row.unit as string | null) ?? null,
      stock: toUnits(row.stock, scale("stock")),
      retailPaisa: toPaisa(row.retail_price, scale("retail_price")),
      garagePaisa: toPaisa(row.garage_price, scale("garage_price")),
      wholesalePaisa: toPaisa(row.wholesale_price, scale("wholesale_price")),
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
      `${extra.make} ${extra.model}`.toLowerCase() === model.toLowerCase() &&
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
      resolved.year = query.year
        ? parseYear(normalize(query.year).tokens, { now: input.now, bare: true })
        : null;
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
  resolved.year = query.year ? parseYear(normalize(query.year).tokens, { now: input.now, bare: true }) : null;
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
    if (!ids.length) return [];
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
    return merged.filter(
      (row) =>
        (!resolved.position || sameValue("position", row.position, resolved.position, dictionary)) &&
        (!resolved.quality || sameValue("quality", row.quality, resolved.quality, dictionary)) &&
        (!resolved.brand || sameValue("brand", row.brand, resolved.brand, dictionary)),
    );
  };

  let rows = await tryType(type.value);
  let pairUsed: string | null = null;
  if (!rows.length) {
    const pair = pairedType(type.value);
    if (pair) {
      rows = await tryType(pair);
      if (rows.length) pairUsed = pair;
    }
  }
  if (rows.length) return { kind: "rows", rows: ordered(rows).slice(0, ROW_LIMIT), resolved, pairUsed };

  // None: recorded fitment for a close vehicle (the same model's other generations), and items whose notes
  // mention the vehicle, both marked unverified (architecture, resolution algorithm, step 5).
  const ids = partsOfType(type.value, catalog.parts, dictionary).map((part) => part.hostId);
  const others = catalog.vehicles.filter(
    (vehicle) =>
      `${vehicle.make} ${vehicle.model}`.toLowerCase() === model.value!.toLowerCase() &&
      !vehicles.vehicles.some((wanted) => wanted.hostId === vehicle.hostId),
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
