import pairsData from "../data/part-pairs.json";
import type { Dictionary } from "./glossary";
import { decide, keySimilarity, matchScore, NBEST_WEIGHTS, phoneticKey } from "./phonetic";
import { normalize } from "./text";

// Part and customer resolvers (spec 10.7; architecture, part and fitment resolver). Pure functions over the catalog
// cache and the rows find_parts returns.

export interface CatalogVehicle {
  hostId: string;
  make: string;
  model: string;
  yearFrom: number;
  yearTo: number | null;
  engineCode: string | null;
  vehicleType: string | null;
}

export interface CatalogPart {
  hostId: string;
  name: string;
  nameBn: string | null;
  partNumbers: string[];
  /** The app's category or group, when it has one ("Brake Pad", "AC Compressor"); counts like the name (D122). */
  category?: string | null;
}

export interface CatalogCustomer {
  hostId: string;
  name: string;
  nameBn: string | null;
}

/** A find_parts row (spec 11.5), money in whole taka (D110). */
export interface PartRow {
  hostPartId: string;
  name: string;
  nameBn: string | null;
  quality: string | null;
  position: string | null;
  brand: string | null;
  unit: string | null;
  stock: number | null;
  retailTaka: bigint | null;
  garageTaka: bigint | null;
  wholesaleTaka: bigint | null;
  rack: string | null;
  /** Every rack the part is kept on when there are several (branches, godowns; D122); rack is the first. */
  racks?: string[];
  fitmentVerified: boolean;
  /** The fit is read only from the part's name or notes, not from the app's records (D122). */
  fitFromName?: boolean;
  /** The vehicle the row's fitment names (its year range and engine separate generations). */
  vehicle?: { hostId: string; yearFrom: number; yearTo: number | null; engineCode: string | null };
}

export const PART_PAIRS: readonly (readonly [string, string])[] = pairsData.pairs.map(([a, b]) => [
  a ?? "",
  b ?? "",
]);

/** The other type of a pair (Brake Pad <-> Brake Shoe), if the type has one. */
export function pairedType(type: string): string | null {
  for (const [a, b] of PART_PAIRS) {
    if (a === type) return b;
    if (b === type) return a;
  }
  return null;
}

const tokensOf = (text: string, dictionary: Dictionary) => normalize(text, dictionary.variants).tokens;

function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

/** The catalog parts of a part type: those whose name (English or Bangla) or category contains one of its spellings. */
export function partsOfType(
  type: string,
  parts: readonly CatalogPart[],
  dictionary: Dictionary,
): CatalogPart[] {
  const spellings = dictionary.terms
    .filter((term) => term.concept === "part_type" && term.value === type)
    .map((term) => term.text.split(" "));
  return parts.filter((part) => {
    const names = [part.name, part.nameBn ?? "", part.category ?? ""].map((name) =>
      tokensOf(name, dictionary),
    );
    return spellings.some((spelling) => names.some((name) => containsRun(name, spelling)));
  });
}

export interface VehicleMatch {
  vehicles: CatalogVehicle[];
  /** Several generations of the model and no year: the year is asked (spec 9.4). */
  needsYear: boolean;
}

/** The words of a car name, split at anything but letters, marks and digits ("Noah/Voxy" -> noah, voxy). */
function carWords(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Whether an app's car is the wanted model (D122): the whole name inside the app's make and model ("Toyota" +
 * "Axio"), or, leaving the wanted make out, the model's words inside the app's model ("Axio", "Axio NZE141", "Corolla
 * Axio"), or the app's model words all within the wanted model ("Sylphy" for Bluebird Sylphy). An app's make that is
 * not the wanted one never matches.
 */
export function isModel(vehicle: { make: string; model: string }, wanted: string): boolean {
  const want = carWords(wanted);
  if (!want.length) return false;
  if (containsRun(carWords(`${vehicle.make} ${vehicle.model}`), want)) return true;
  if (want.length < 2) return false;
  const [wantMake, ...wantModel] = want;
  const make = carWords(vehicle.make);
  if (make.length && !make.includes(wantMake!)) return false;
  const model = carWords(vehicle.model).filter((word) => !make.includes(word) && word !== wantMake);
  if (!model.length) return false;
  return (
    containsRun(model, wantModel) ||
    (model.some((word) => word.length >= 3) && model.every((word) => wantModel.includes(word)))
  );
}

/** The vehicles of a model whose year range contains the year (and with the engine, if one is given). */
export function matchVehicles(
  model: string,
  year: number | null,
  engine: string | null,
  vehicles: readonly CatalogVehicle[],
): VehicleMatch {
  let found = vehicles.filter((vehicle) => isModel(vehicle, model));
  if (engine) found = found.filter((vehicle) => (vehicle.engineCode ?? "").toUpperCase().startsWith(engine));
  if (year !== null) {
    found = found.filter(
      (vehicle) => vehicle.yearFrom <= year && year <= (vehicle.yearTo ?? Number.MAX_SAFE_INTEGER),
    );
    return { vehicles: found, needsYear: false };
  }
  return { vehicles: found, needsYear: found.length > 1 };
}

export const SEPARATING_SLOTS = ["year", "engine", "position", "quality", "brand"] as const;
export type SeparatingSlot = (typeof SEPARATING_SLOTS)[number];

function slotValue(row: PartRow, slot: SeparatingSlot): string | null {
  switch (slot) {
    case "year":
      return row.vehicle ? `${row.vehicle.yearFrom}-${row.vehicle.yearTo ?? ""}` : null;
    case "engine":
      return row.vehicle?.engineCode ?? null;
    case "position":
      return row.position;
    case "quality":
      return row.quality;
    case "brand":
      return row.brand;
  }
}

export interface SlotOption {
  value: string;
  rows: PartRow[];
  /** The customer's tier price, else retail, of the option's cheapest row. */
  priceTaka: bigint | null;
  stock: number;
}

/**
 * The slot that best separates the remaining parts: the most distinct values among year, engine, position, quality
 * and brand (ties in that order), with its options as chips. Null when the rows cannot be told apart by these.
 */
export function separatingSlot(
  rows: readonly PartRow[],
  tier: "retail" | "garage" | "wholesale" = "retail",
): { slot: SeparatingSlot; options: SlotOption[] } | null {
  let chosen: SeparatingSlot | null = null;
  let most = 1;
  for (const slot of SEPARATING_SLOTS) {
    const values = new Set(rows.map((row) => slotValue(row, slot)).filter((value) => value !== null));
    if (values.size > most) {
      most = values.size;
      chosen = slot;
    }
  }
  if (!chosen) return null;
  const slot = chosen;
  const groups = new Map<string, PartRow[]>();
  for (const row of rows) {
    const value = slotValue(row, slot);
    if (value === null) continue;
    groups.set(value, [...(groups.get(value) ?? []), row]);
  }
  const price = (row: PartRow) =>
    (tier === "garage" ? row.garageTaka : tier === "wholesale" ? row.wholesaleTaka : null) ?? row.retailTaka;
  const options = [...groups.entries()].map(([value, group]) => {
    const prices = group.map(price).filter((taka): taka is bigint => taka !== null);
    return {
      value,
      rows: group,
      priceTaka: prices.length ? prices.reduce((low, taka) => (taka < low ? taka : low)) : null,
      stock: group.reduce((sum, row) => sum + (row.stock ?? 0), 0),
    };
  });
  return { slot, options };
}

export interface CustomerCandidate {
  customer: CatalogCustomer;
  score: number;
}

export interface CustomerMatch {
  candidates: CustomerCandidate[];
  decision: "understood" | "understood_bold" | "ambiguous" | "unclear";
}

/** Score of a name that the spoken words begin (Rahim -> Rahim Motors): enough to be asked about, not assumed. */
const BEGINS_NAME = 0.85;

/**
 * Matches a said customer name (and the other N-best hypotheses' words at the same place) against the catalog. Two
 * candidates at 0.85 or more, two within 0.05, or spoken words that begin several names are ambiguous and asked with
 * the names.
 */
export function resolveCustomer(
  said: string,
  hypotheses: readonly string[],
  customers: readonly CatalogCustomer[],
  dictionary: Dictionary,
): CustomerMatch {
  const saidTokens = tokensOf(said, dictionary);
  const saidKey = phoneticKey(saidTokens.join(" "));
  const saidKeys = saidTokens.map((token) => phoneticKey(token));
  const texts = [
    { text: said, weight: NBEST_WEIGHTS[0] },
    ...hypotheses
      .slice(0, NBEST_WEIGHTS.length)
      .map((text, rank) => ({ text, weight: NBEST_WEIGHTS[rank] ?? 0 })),
  ];
  const beginning = customers.filter((customer) => {
    const keys = [customer.name, customer.nameBn ?? ""].map((name) =>
      tokensOf(name, dictionary).map((token) => phoneticKey(token)),
    );
    return keys.some(
      (name) =>
        saidKeys.length > 0 && saidKeys.length < name.length && saidKeys.every((key, i) => key === name[i]),
    );
  });
  const candidates: CustomerCandidate[] = customers
    .map((customer) => {
      let score = beginning.includes(customer) ? BEGINS_NAME : 0;
      for (const name of [customer.name, customer.nameBn].filter((value): value is string =>
        Boolean(value),
      )) {
        const nameText = tokensOf(name, dictionary).join(" ");
        const nameKey = phoneticKey(nameText);
        for (const { text, weight } of texts) {
          const heard = tokensOf(text, dictionary).join(" ");
          const exact = heard === nameText;
          const key = phoneticKey(heard);
          if (!exact && text !== said && keySimilarity(key, saidKey) < 0.5) continue;
          score = Math.max(score, weight * matchScore(exact, exact ? 1 : keySimilarity(key, nameKey)));
        }
      }
      return { customer, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  const [first, second] = candidates;
  if (beginning.length > 1 || (first && second && second.score >= 0.85)) {
    return { candidates, decision: "ambiguous" };
  }
  const decision = decide(first?.score ?? 0, second?.score ?? 0);
  if (decision === "unclear" && first && second && first.score >= 0.7 && first.score - second.score < 0.05) {
    return { candidates, decision: "ambiguous" };
  }
  return { candidates, decision };
}
