import { normalize, type Dictionary } from "@dokaanbondhu/core";
import type { Catalog } from "./catalog";
import type { FitmentExtra } from "./find-parts";

// Fit read from a part's name and notes (D122): many shop apps keep no part-to-car table and write the cars in the
// part ("AC Compressor Axio/Fielder 2012-17", "Fits Axio 2012-2017"). At catalog sync, the parts the app's own table
// does not cover are read for a car the dictionary knows and a year range; each becomes a fitment_extra row with
// source "parsed", never verified, and the answer says the fit is taken from the name.

/** Two-digit years as in the app: 16 is 2016, 98 is 1998. */
function fullYear(text: string, now: Date): number {
  const year = Number(text);
  if (text.length > 2) return year;
  return year <= (now.getFullYear() % 100) + 1 ? 2000 + year : 1900 + year;
}

/** The years written in a text: a range ("2012-17", "2012 to 2017", "2018+"), one year, or none (any year). */
export function yearsInText(text: string, now = new Date()): { from: number | null; to: number | null } {
  const range = /\b((?:19|20)\d{2}|\d{2})\s*(?:-|–|—|to|~)\s*((?:19|20)\d{2}|\d{2})\b/i.exec(text);
  if (range) {
    const from = fullYear(range[1]!, now);
    const to = fullYear(range[2]!, now);
    if (from >= 1950 && to >= from) return { from, to };
  }
  const open = /\b((?:19|20)\d{2})\s*(?:\+|onwards?\b)/i.exec(text);
  if (open) return { from: Number(open[1]), to: null };
  const one = /\b((?:19|20)\d{2})\b/.exec(text);
  if (one) return { from: Number(one[1]), to: Number(one[1]) };
  return { from: null, to: null };
}

/**
 * The cars a part's name or notes mention, by the dictionary's car spellings (the glossary's and the app's own). A
 * spelling of three letters or fewer ("fit") counts only with its make written too.
 */
export function carsInText(text: string, dictionary: Dictionary): string[] {
  const words = normalize(text.replace(/[/,;()]+/g, " ")).tokens;
  const found = new Set<string>();
  for (const term of dictionary.terms) {
    if (term.concept !== "vehicle_model") continue;
    const spelling = term.text.split(" ");
    const short = spelling.length === 1 && spelling[0]!.length <= 3;
    if (short) continue;
    for (let start = 0; start + spelling.length <= words.length; start += 1) {
      if (spelling.every((word, offset) => words[start + offset] === word)) {
        found.add(term.value);
        break;
      }
    }
  }
  // "Toyota Axio" also matched its "axio": one value per car.
  return [...found];
}

/** Parsed fitment rows for the parts the app's own fitment table does not cover. */
export function parsedFitments(
  catalog: Catalog,
  dictionary: Dictionary,
  covered: ReadonlySet<string>,
  now = new Date(),
): FitmentExtra[] {
  const rows: FitmentExtra[] = [];
  for (const part of catalog.parts) {
    if (covered.has(part.hostId)) continue;
    const notes = typeof part.attrs.notes === "string" ? part.attrs.notes : "";
    const text = `${part.name} ${notes}`;
    const cars = carsInText(text, dictionary);
    if (!cars.length) continue;
    const years = yearsInText(text, now);
    for (const car of cars) {
      rows.push({
        hostPartId: part.hostId,
        make: "",
        model: car,
        yearFrom: years.from,
        yearTo: years.to,
        engineCode: null,
        verified: false,
        source: "parsed",
      });
    }
  }
  return rows;
}
