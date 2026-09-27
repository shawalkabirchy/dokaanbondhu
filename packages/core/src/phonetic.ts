import { distance } from "fastest-levenshtein";
import table from "../data/bn-latin.json";
import { asciiDigits, isBangla } from "./text";

// Phonetic key and match scores (spec 10.3).

const sequences = Object.entries(table.sequences as Record<string, string>);
const letters = table.letters as Record<string, string>;

function fromBangla(text: string): string {
  let out = text.normalize("NFC");
  for (const [sequence, latin] of sequences) out = out.split(sequence).join(latin);
  return [...out].map((char) => letters[char] ?? (/[a-z0-9]/.test(char) ? char : "")).join("");
}

const CH = String.fromCodePoint(0xe000); // private-use placeholder

function simplifyLatin(text: string): string {
  let out = text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/ph/g, "f")
    .replace(/bh/g, "b")
    .replace(/dh/g, "d")
    .replace(/th/g, "t")
    .replace(/kh/g, "k")
    .replace(/gh/g, "g")
    .replace(/sh/g, "s")
    .replace(/t?ch/g, CH); // ch ends as c, like চ, and stays out of the c rules below
  out = out
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .split(CH)
    .join("c");
  return out
    .replace(/z/g, "j")
    .replace(/q/g, "k")
    .replace(/v/g, "b")
    .replace(/w/g, "o")
    .replace(/x/g, "ks")
    .replace(/y/g, "i");
}

/** The key keeps the first letter, drops the other vowels and collapses repeated letters: self, সেলফ -> slf. */
export function phoneticKey(text: string): string {
  const latin = asciiDigits(text)
    .split(/\s+/)
    .map((word) => (isBangla(word) ? fromBangla(word) : simplifyLatin(word)))
    .join("");
  if (!latin) return "";
  const rest = latin.slice(1).replace(/[aeiou]/g, "");
  return (latin[0] + rest).replace(/(.)\1+/g, "$1");
}

/** 1 - lev(a, b) / max(|a|, |b|). */
export function keySimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  return 1 - distance(a, b) / Math.max(a.length, b.length);
}

/** Weights of the N-best hypotheses by rank 0..4. */
export const NBEST_WEIGHTS = [1.0, 0.95, 0.9, 0.85, 0.8] as const;

/** One hypothesis' score for a candidate: 1.0 for an exact normalized match, else 0.9 x similarity (0 below 0.6). */
export function matchScore(exact: boolean, similarity: number): number {
  if (exact) return 1;
  return similarity >= 0.6 ? 0.9 * similarity : 0;
}

export type Understanding = "understood" | "understood_bold" | "unclear";

/** Decisions on the best score (starting values, tuned on the open half of the test set). */
export function decide(best: number, second = 0): Understanding {
  if (best < 0.7 || best - second < 0.05) return "unclear";
  return best >= 0.85 ? "understood" : "understood_bold";
}
