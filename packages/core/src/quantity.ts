import numbers from "../data/bn-numbers.json";
import { wordNumber } from "./numbers";
import { asciiDigits } from "./text";

// Quantity normalizer (spec 10.6; architecture, quantity and number normalizer). Rule-based: quantities touch
// money and stock, so they are never left to the LLM.

export const UNITS = ["piece", "set", "pair", "hali", "dozen", "liter", "tin", "box"] as const;
export type Unit = (typeof UNITS)[number];

const UNIT_WORDS: ReadonlyMap<string, Unit> = new Map(
  (
    [
      ["piece", ["টা", "টি", "পিস", "ta", "ti", "pis", "piece", "pieces", "pcs"]],
      ["set", ["সেট", "set", "sets"]],
      ["pair", ["জোড়া", "জোড়", "jora", "pair", "pairs"]],
      ["hali", ["হালি", "hali"]],
      ["dozen", ["ডজন", "dozon", "dozen"]],
      ["liter", ["লিটার", "liter", "litre", "litar", "liters", "l"]],
      ["tin", ["টিন", "গ্যালন", "tin", "gallon", "galon"]],
      ["box", ["বক্স", "কার্টন", "box", "carton", "kartun"]],
    ] as const
  ).flatMap(([unit, words]) => words.map((word) => [word.normalize("NFC"), unit as Unit] as const)),
);
const PIECES: Partial<Record<Unit, number>> = { pair: 2, hali: 4, dozen: 12 };
const WHOLE_FRACTIONS = new Map(
  Object.entries(numbers.fractions.whole).map(([w, v]) => [w.normalize("NFC"), v]),
);
const BEFORE_NUMBER = new Map(
  Object.entries(numbers.fractions.before_number).map(([w, v]) => [w.normalize("NFC"), v]),
);

export interface SaidQuantity {
  value: number;
  unit: Unit | null;
}

/** A number with a classifier attached: একটা, দুইটা, ekta, duita. */
function withClassifier(token: string): { value: number; unit: Unit } | null {
  for (const ending of ["টা", "টি", "টো", "ta", "ti", "to"]) {
    if (token.length > ending.length && token.endsWith(ending)) {
      const stem = token.slice(0, -ending.length);
      const value = wordNumber(stem) ?? wordNumber(stem === "দু" || stem === "du" ? "দুই" : stem);
      if (value !== null) return { value, unit: "piece" };
    }
  }
  return null;
}

/** Unit words long enough to be read glued to their number, longest first (টা and ta are classifiers, above). */
const GLUED_UNITS = [...UNIT_WORDS.keys()]
  .filter((word) => [...word].length >= 3)
  .sort((a, b) => b.length - a.length);

/**
 * A number and its unit written as one word, as speech-to-text writes them: "দুইসেট", "duiset", "এক্সেট", and
 * "exet" for "ek set" (x for ks). Only a head that reads as a number is taken, so "reset", "headset" or "চেইনসেট" are
 * no quantity (D170).
 */
export function gluedQuantity(token: string): SaidQuantity | null {
  const word = token.normalize("NFC");
  const spelled = /^[a-z]+$/.test(word) ? word.replaceAll("x", "ks") : word;
  for (const unitWord of GLUED_UNITS) {
    if (spelled.length <= unitWord.length || !spelled.endsWith(unitWord)) continue;
    const head = spelled.slice(0, -unitWord.length).replace(/্$/u, "");
    const ascii = asciiDigits(head);
    const value = /^\d+(\.\d+)?$/.test(ascii) ? Number(ascii) : wordNumber(head);
    if (value !== null && value > 0) return { value, unit: UNIT_WORDS.get(unitWord)! };
  }
  return null;
}

/**
 * A number and its unit joined by a hyphen: "ek-set", "dui-ta" (D170). Only with a unit after it, so a rack ("B-3") or
 * a part number ("04465-12610") is no quantity.
 */
function hyphened(token: string): SaidQuantity | null {
  const halves = token.split("-");
  if (halves.length !== 2 || !halves[0] || !halves[1]) return null;
  const split = parseQuantity(halves);
  return split?.unit ? split : null;
}

/** The first quantity in normalized tokens: digits, number words, fractions and a unit word if one follows. */
export function parseQuantity(tokens: readonly string[]): SaidQuantity | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = (tokens[index] ?? "").normalize("NFC");
    const next = (tokens[index + 1] ?? "").normalize("NFC");
    let value: number | null;
    let used = 1;
    const shift = BEFORE_NUMBER.get(token);
    const whole = WHOLE_FRACTIONS.get(token);
    if (shift !== undefined) {
      const base = wordNumber(next);
      if (base === null) continue;
      value = base + shift;
      used = 2;
    } else if (whole !== undefined) {
      value = whole;
    } else {
      const classified = withClassifier(token) ?? gluedQuantity(token) ?? hyphened(token);
      if (classified) return classified;
      const ascii = asciiDigits(token);
      value = /^\d+(\.\d+)?$/.test(ascii) ? Number(ascii) : wordNumber(token);
      if (value === null) continue;
      // "tin" is three, unless a number comes before it (then it is a tin)
      if (UNIT_WORDS.get(token) === "tin" && index > 0 && wordNumber(tokens[index - 1] ?? "") !== null)
        continue;
    }
    const unit = UNIT_WORDS.get((tokens[index + used] ?? "").normalize("NFC")) ?? null;
    return { value: Math.round(value * 1000) / 1000, unit };
  }
  return null;
}

export interface PartUnit {
  unit: Unit | string; // how the host sells the part
  packSize?: number | null; // liters or pieces in one tin or box
}

export type QuantityCheck =
  | { ok: true; quantity: number } // in the part's own unit
  | { ok: false; reason: "ask_unit" | "ask_pack" | "fraction_not_allowed" | "unclear" };

/** Checks a said quantity against how the host sells the part. */
export function checkQuantity(said: SaidQuantity, part: PartUnit): QuantityCheck {
  const { value } = said;
  if (!(value > 0) || value > 1000) return { ok: false, reason: "unclear" };
  const unit = said.unit ?? (part.unit as Unit);
  if (!Number.isInteger(value) && part.unit !== "liter") return { ok: false, reason: "fraction_not_allowed" };
  if (unit === part.unit) return { ok: true, quantity: value };
  const pieces = PIECES[unit];
  if (pieces !== undefined) {
    return part.unit === "piece" ? { ok: true, quantity: value * pieces } : { ok: false, reason: "ask_unit" };
  }
  if (unit === "tin" || unit === "box") {
    if (!part.packSize) return { ok: false, reason: "ask_pack" };
    return { ok: true, quantity: value * part.packSize };
  }
  return { ok: false, reason: "ask_unit" }; // piece against set, or the reverse: asked, never converted
}
