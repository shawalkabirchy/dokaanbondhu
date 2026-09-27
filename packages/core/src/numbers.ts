import numbers from "../data/bn-numbers.json";
import spelled from "../data/spelled-letters.json";
import { asciiDigits } from "./text";

// Years, engine codes and part numbers (spec 10.5), and number words shared with the quantity normalizer (10.6).

const nfc = (text: string) => text.normalize("NFC").toLowerCase();

/** Number words: Bangla 0-100, Banglish forms, English one to twenty. */
export const NUMBER_WORDS: ReadonlyMap<string, number> = new Map(
  [...Object.entries(numbers.bn), ...Object.entries(numbers.latin), ...Object.entries(numbers.english)].map(
    ([word, value]) => [nfc(word), value],
  ),
);
const YEAR_WORDS = new Set([...numbers.year_words.bn, ...numbers.year_words.latin].map(nfc));

/** A token as a whole number: digits (Bangla or ASCII) or a number word. */
export function wordNumber(token: string): number | null {
  const ascii = asciiDigits(token);
  if (/^\d+$/.test(ascii)) return Number(ascii);
  return NUMBER_WORDS.get(nfc(token)) ?? null;
}

/** A two-digit year: 2000 + n up to next year, else 1900 + n. */
export function expandYear(twoDigits: number, now: Date = new Date()): number {
  const limit = (now.getFullYear() % 100) + 1;
  return twoDigits <= limit ? 2000 + twoDigits : 1900 + twoDigits;
}

function isYear(value: number, now: Date): boolean {
  return value >= 1980 && value <= now.getFullYear() + 1;
}

/**
 * The model year in normalized tokens: four digits from 1980 to next year; or a two-digit number (digits or words)
 * next to model, sal, saler or their Bangla words. `bare` accepts a two-digit number on its own, for a value that
 * was said as the year (a tool's year argument).
 */
export function parseYear(
  tokens: readonly string[],
  options: { now?: Date; bare?: boolean } = {},
): number | null {
  const now = options.now ?? new Date();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = asciiDigits(tokens[index] ?? "");
    if (/^\d{4}$/.test(token) && isYear(Number(token), now)) return Number(token);
    const value = wordNumber(tokens[index] ?? "");
    if (value === null || value > 99 || (/^\d+$/.test(token) && token.length > 2)) continue;
    const nextToYearWord = [tokens[index - 1], tokens[index + 1]].some(
      (near) => near && YEAR_WORDS.has(nfc(near)),
    );
    if (nextToYearWord || options.bare) {
      const year = expandYear(value, now);
      if (isYear(year, now)) return year;
    }
  }
  return null;
}

const SPOKEN: ReadonlyMap<string, string> = new Map([
  ...Object.entries(spelled.letters).flatMap(([letter, words]) =>
    words.map((word) => [nfc(word), letter] as const),
  ),
  ...Object.entries(spelled.digits).flatMap(([digit, words]) =>
    words.map((word) => [nfc(word), digit] as const),
  ),
]);

/**
 * An engine code from tokens: written (1nz, 1nz-fe) or spelled one sign at a time (one en zed, ওয়ান এন জেড). The
 * longest run of spelled signs (at least two) that contains a letter and a digit, upper-cased.
 */
export function parseEngineCode(tokens: readonly string[]): string | null {
  for (const token of tokens) {
    const ascii = asciiDigits(token);
    if (/^\d[a-z]{1,3}(-[a-z]{2,4})?$/i.test(ascii)) return ascii.toUpperCase();
  }
  let best = "";
  let run = "";
  for (const token of [...tokens, ""]) {
    const sign = SPOKEN.get(nfc(token)) ?? (/^[0-9]$/.test(asciiDigits(token)) ? asciiDigits(token) : null);
    if (sign !== null) {
      run += sign;
      continue;
    }
    if (run.length >= 2 && /\d/.test(run) && /[a-z]/.test(run) && run.length > best.length) best = run;
    run = "";
  }
  return best ? best.toUpperCase() : null;
}

/** A part number for matching: upper case without spaces, dashes or dots. */
export function normalizePartNumber(text: string): string {
  return asciiDigits(text)
    .toUpperCase()
    .replace(/[\s.\-/]/g, "");
}

function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * A said part number against the known ones: an exact match is used; numbers one edit away are only offered ("did
 * you mean ...?"), never taken.
 */
export function matchPartNumber(
  said: string,
  known: readonly string[],
): { exact: string | null; offered: string[] } {
  const target = normalizePartNumber(said);
  if (target.length < 3) return { exact: null, offered: [] };
  const exact = known.find((number) => normalizePartNumber(number) === target) ?? null;
  if (exact) return { exact, offered: [] };
  return {
    exact: null,
    offered: known.filter((number) => oneEditApart(normalizePartNumber(number), target)),
  };
}
