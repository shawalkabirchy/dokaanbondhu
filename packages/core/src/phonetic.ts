import table from "../data/bn-latin.json";
import { asciiDigits, isBangla, normalize } from "./text";

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

/**
 * How a text sounds in Latin letters, vowels kept (D153): এসডিও → esdio, এক্সিও → eksio, "Nawabpur" → naoabpur. The LLM
 * compares sounds better in Latin letters than in Bangla spellings.
 */
export function soundOf(text: string): string {
  return asciiDigits(text)
    .split(/\s+/)
    .map((word) => (isBangla(word) ? fromBangla(word) : simplifyLatin(word)))
    .filter(Boolean)
    .join(" ");
}

/** 1 - distance / longer length between two sounds, spaces left out (D153). */
export function soundSimilarity(a: string, b: string): number {
  const x = soundOf(a).replace(/ /g, "");
  const y = soundOf(b).replace(/ /g, "");
  if (!x || !y) return 0;
  return 1 - soundDistance(x, y) / Math.max(x.length, y.length);
}

const BUTTON_MAX_WORDS = 2;
const BUTTON_MIN_SOUND = 0.75;
const BUTTON_MIN_LEAD = 0.25;

/**
 * The button a short answer sounds like (D211), the best guess first: speech-to-text can write a button's word another
 * way (পাইকারী for পাইকারি) or split it (পাইকার ই). Only for buttons of fixed words: null unless the answer is close to
 * one button and clearly nearer it than to the others.
 */
export function optionBySound<Option extends { label: string }>(
  guesses: readonly string[],
  options: readonly Option[],
): Option | null {
  for (const guess of guesses) {
    const words = normalize(guess).tokens.length;
    if (!words || words > BUTTON_MAX_WORDS) continue;
    const [best, next] = options
      .map((option) => ({ option, score: soundSimilarity(guess, option.label) }))
      .sort((a, b) => b.score - a.score);
    if (best && best.score >= BUTTON_MIN_SOUND && best.score - (next?.score ?? 0) >= BUTTON_MIN_LEAD)
      return best.option;
  }
  return null;
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

/**
 * Sounds speech-to-text mixes up (D152, from the owner's voice tests): a voiced and an unvoiced stop (ব/প, ড/ট, গ/ক,
 * জ/চ) and ফ and প anywhere; at a word's end, ন for ড (প্যান for প্যাড) and an ন heard or lost (প্যান্ট for প্যাড).
 * Each costs half a letter, but only where the caller allows it: for a word that is not already a known word (so
 * ফিল্টার is never bent into Fielder) and only on keys of four letters or more (so পাওয়ার is never পুরানো).
 */
const NEAR_SOUNDS = new Set(["bp", "pb", "dt", "td", "gk", "kg", "cj", "jc", "fp", "pf"]);
const NASAL_GAP = 0.5;
/** Whether a letter is among the last two of its key, where the ন of প্যান্ট sits. */
const atEnd = (key: string, index: number) => index >= key.length - 2;
const NEAR_MIN_KEY = 4;

/** Edit distance between two keys; with `near`, the near sounds cost half. */
export function soundDistance(a: string, b: string, near = false): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const x = a[i - 1]!;
      const y = b[j - 1]!;
      const nasal = (letter: string, key: string, index: number) =>
        near && letter === "n" && atEnd(key, index) ? NASAL_GAP : 1;
      const nearSwap =
        NEAR_SOUNDS.has(x + y) || ((x + y === "nd" || x + y === "dn") && atEnd(a, i - 1) && atEnd(b, j - 1));
      const swap = x === y ? 0 : near && nearSwap ? 0.5 : 1;
      current[j] = Math.min(
        previous[j - 1]! + swap,
        previous[j]! + nasal(x, a, i - 1),
        current[j - 1]! + nasal(y, b, j - 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * 1 - distance(a, b) / max(|a|, |b|). With `near` (a misheard word, D152), a voiced and an unvoiced stop count half
 * on keys of four letters or more.
 */
export function keySimilarity(a: string, b: string, near = false): number {
  if (!a || !b) return 0;
  const allowNear = near && Math.min(a.length, b.length) >= NEAR_MIN_KEY;
  return 1 - soundDistance(a, b, allowNear) / Math.max(a.length, b.length);
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
