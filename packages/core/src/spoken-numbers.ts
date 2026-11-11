import { distance } from "fastest-levenshtein";
import spelled from "../data/spelled-letters.json";
import { NUMBER_WORDS, normalizePartNumber, spokenSign } from "./numbers";
import { soundDistance, soundOf } from "./phonetic";
import { asciiDigits, normalize } from "./text";

// Numbers said sign by sign (D237): a part number, a phone or a rack said digit by digit, the way speech-to-text
// writes English digit words in Bangla letters ("থ্রি জিরো জিনো ওয়ান"), misheard ("জিলো" for জিরো), glued ("ওয়ানটু")
// or with ডাবল. Found in the first voice run of the test set, where 9 of 63 clips failed on them.

const nfc = (text: string) => text.normalize("NFC").toLowerCase();

/** How each letter and digit sounds when said in English, as Bangla letters write it: k "ke", 3 "tri" (D237). */
const SIGN_SOUND = new Map<string, string>([
  ...Object.entries(spelled.letters).map(([letter, words]) => [letter, soundOf(words[0]!)] as const),
  ...Object.entries(spelled.digits).map(([digit, words]) => [digit, soundOf(words[0]!)] as const),
]);

/** Signs as they sound said one by one: "kyb300115" as "keoiaibitrijirojiro…". */
const signSound = (signs: string) => [...signs].map((sign) => SIGN_SOUND.get(sign) ?? sign).join("");

/**
 * The English digit words by sound, in both scripts ("জিরো" and "zero"): a misheard one is found by sound. The Bangla
 * ones (শূন্য, এক, দুই …) are whole words of everyday speech, so they count only when written exactly.
 */
const DIGIT_SOUNDS: readonly (readonly [string, string])[] = Object.entries(spelled.digits).flatMap(
  ([digit, words]) => words.slice(0, 2).map((word) => [digit, soundOf(word)] as const),
);

const DOUBLE = new Set(["ডাবল", "double", "dabol", "dabal", "dobol"].map(nfc));
const TRIPLE = new Set(["ট্রিপল", "triple", "tripol", "tripal"].map(nfc));
/** How many times the next sign is said: ডাবল ফাইভ is 55. */
export const repeatWord = (token: string) => (DOUBLE.has(nfc(token)) ? 2 : TRIPLE.has(nfc(token)) ? 3 : 1);

/**
 * A token that is one said sign or number exactly, as its signs: a spelled letter or digit ("সি", "থ্রি", "one"), a
 * number word below 100 ("পঞ্চাশ" 50, "টেন" 10) or written signs with a digit ("300115", "b3"). Null for any other.
 */
export function exactSigns(token: string): string | null {
  const sign = spokenSign(token);
  if (sign !== null) return sign;
  const ascii = asciiDigits(token).toLowerCase();
  if (/^[a-z0-9]+$/.test(ascii) && /\d/.test(ascii)) return ascii;
  const value = NUMBER_WORDS.get(nfc(token));
  return value !== undefined && value < 100 ? String(value) : null;
}

/**
 * Edits a piece may differ from a digit word by: one when both have three letters or more ("জিলো" 0, "এইড" 8), else
 * none, so the letter "টি" (ti) is never a three (tri).
 */
const pieceEdits = (piece: string, digitSound: string) =>
  piece.length >= 3 && digitSound.length >= 3 ? 1 : 0;

/**
 * One token as digits: exact (a digit or number word), else by sound, misheard or glued English digit words split
 * into up to three digits ("জিলো" 0, "ওয়াইন" 1, "ওয়াংওয়ান" 11, "ওয়ানটু" 12). Null when it is no digit word.
 */
export function digitsBySound(token: string): string | null {
  const exact = exactSigns(token);
  if (exact !== null) return /^\d+$/.test(exact) ? exact : null;
  return digitSplit(token)?.digits ?? null;
}

/** A word split into English digit words by sound, with the edits it took; null when it splits no such way. */
function digitSplit(token: string): { digits: string; cost: number } | null {
  if (/^\p{M}/u.test(token)) return null; // a piece cut inside a Bangla letter, never a word
  const sound = soundOf(token).replace(/ /g, "");
  if (sound.length < 2) return null;
  // best[i]: the fewest edits that split sound[0..i) into digit words
  const best: ({ cost: number; digits: string } | null)[] = [{ cost: 0, digits: "" }];
  for (let end = 1; end <= sound.length; end += 1) {
    best[end] = null;
    for (let start = Math.max(0, end - 7); start < end; start += 1) {
      const before = best[start];
      if (!before) continue;
      const piece = sound.slice(start, end);
      for (const [digit, digitSound] of DIGIT_SOUNDS) {
        const edits = soundDistance(piece, digitSound);
        if (edits > pieceEdits(piece, digitSound)) continue;
        const cost = before.cost + edits;
        const current = best[end];
        if (!current || cost < current.cost) best[end] = { cost, digits: before.digits + digit };
      }
    }
  }
  const whole = best[sound.length];
  return whole && whole.digits.length <= 3 ? whole : null;
}

/**
 * The digits said in a text, in order: digit and number words and ডাবল, and, with `bySound`, misheard or glued digit
 * words that sit next to a digit already read (so "ফোন" is never a four). Each token's digits, or null for a word
 * that is none. A phone reads only exact words, since a misheard digit is never guessed (D211); the clean-up uses the
 * sound to leave a number's words alone (D237).
 */
export function digitRun(tokens: readonly string[], options: { bySound?: boolean } = {}): (string | null)[] {
  const exact = tokens.map((token) => {
    if (repeatWord(token) > 1) return "";
    const signs = exactSigns(token);
    return signs !== null && /^\d+$/.test(signs) ? signs : null;
  });
  if (options.bySound === false) return exact;
  const bySound = tokens.map((token, index) => (exact[index] === null ? digitsBySound(token) : null));
  const read = [...exact];
  // A digit word by sound is taken when it touches a digit already read, so a chain of misheard ones is read too.
  for (let changed = true; changed;) {
    changed = false;
    tokens.forEach((_, index) => {
      const heard = bySound[index] ?? null;
      if (read[index] !== null || heard === null) return;
      if (read[index - 1] != null || read[index + 1] != null) {
        read[index] = heard;
        changed = true;
      }
    });
  }
  return read;
}

/** Words that say a part number comes next or came just before: নম্বর, number, পার্ট and their endings. */
const CUE_STEMS = [
  "নম্বর",
  "নাম্বার",
  "নাম্বর",
  "নম্বার",
  "নং",
  "পার্ট",
  "পাট",
  "number",
  "nombor",
  "nambar",
  "nomber",
  "part",
  "pat",
].map(nfc);
const isCue = (token: string) => CUE_STEMS.some((stem) => nfc(token).startsWith(stem));

/** Letters said as one word, as typed ("kyb", "dnsp"): Latin letters without a vowel are spelled letter by letter. */
const spelledWord = (token: string) => (/^[a-z]{2,5}$/.test(token) && !/[aeiou]/.test(token) ? token : null);

interface WordSound {
  /** The word's sound: a sign or number word as its signs' canonical sounds, any other word as it sounds. */
  piece: string;
  /** Whether it is a digit or letter word, said exactly or by sound, or ডাবল. */
  sign: boolean;
  /** 2 for ডাবল, 3 for ট্রিপল, else 1. */
  repeat: number;
}

/** Each word's sound, worked out once per word (a sentence is tried in many windows). */
function wordSound(token: string): WordSound {
  const repeat = repeatWord(token);
  if (repeat > 1) return { piece: "", sign: true, repeat };
  const exact = exactSigns(token) ?? spelledWord(token);
  if (exact !== null) return { piece: signSound(exact), sign: true, repeat: 1 };
  return { piece: soundOf(token).replace(/ /g, ""), sign: digitsBySound(token) !== null, repeat: 1 };
}

/** How a run of words sounds, a ডাবল repeating the next word, and how many sign words it holds. */
function heardSound(words: readonly WordSound[]): { sound: string; signs: number } {
  let sound = "";
  let signs = 0;
  let times = 1;
  for (const word of words) {
    if (word.sign) signs += 1;
    if (word.repeat > 1) {
      times = word.repeat;
      continue;
    }
    sound += word.piece.repeat(times);
    times = 1;
  }
  return { sound, signs };
}

const WINDOW = 12; // the most words a part number is said in
const MIN_SIGNS = 3; // digit or letter words in it, so an ordinary phrase before "পার্ট" is never one
export const PART_NUMBER_MIN_SOUND = 0.7;
export const PART_NUMBER_LEAD = 0.06;

export interface SpokenPartNumber {
  /** The shop's part number said, when one is clearly nearest; null otherwise. */
  number: string | null;
  /** The nearest few when none is clearly nearest, for buttons; the chosen one alone when one is. */
  close: string[];
  /** The words that said it, [from, to) in the normalized tokens. */
  span: [number, number] | null;
}

const NONE: SpokenPartNumber = { number: null, close: [], span: null };

/**
 * A part number said aloud, matched by sound against the shop's own part numbers (D237): the words just before or
 * after a cue (নম্বর, পার্ট …), or anywhere for an answer to "which part number?", compared with how each number
 * sounds said sign by sign. Taken only when one number is clearly nearest; several close ones are given for buttons,
 * and `prefer` (the part type said) may pick one of them. Works for any app: only its own numbers are compared.
 */
export function partNumberBySound(
  text: string,
  known: readonly string[],
  options: { anywhere?: boolean; prefer?: (number: string) => boolean } = {},
): SpokenPartNumber {
  const tokens = normalize(text).tokens;
  if (!tokens.length || !known.length) return NONE;
  const windows: [number, number][] = [];
  if (options.anywhere) {
    for (let from = 0; from < tokens.length; from += 1)
      for (let to = from + 1; to <= Math.min(tokens.length, from + WINDOW); to += 1) windows.push([from, to]);
  } else {
    tokens.forEach((token, index) => {
      if (!isCue(token)) return;
      for (let size = 1; size <= WINDOW; size += 1) {
        if (index - size >= 0) windows.push([index - size, index]);
        if (index + 1 + size <= tokens.length) windows.push([index + 1, index + 1 + size]);
      }
    });
  }
  const words = tokens.map(wordSound);
  // One window per sound: the same words around two cues are compared once.
  const sounds = new Map<string, [number, number]>();
  for (const span of windows) {
    const window = heardSound(words.slice(span[0], span[1]));
    if (window.signs >= MIN_SIGNS && window.sound && !sounds.has(window.sound))
      sounds.set(window.sound, span);
  }
  const heard = [...sounds].map(([sound, span]) => ({ sound, span }));
  if (!heard.length) return NONE;
  const numbers = new Map<string, string>();
  for (const number of known) {
    const key = normalizePartNumber(number);
    if (key.length >= 4 && !numbers.has(key)) numbers.set(key, number);
  }
  const best = new Map<string, { score: number; span: [number, number] }>();
  for (const [key, number] of numbers) {
    const target = signSound(key.toLowerCase());
    for (const window of heard) {
      const longer = Math.max(window.sound.length, target.length);
      if (Math.abs(window.sound.length - target.length) > longer * (1 - PART_NUMBER_MIN_SOUND)) continue;
      const score = 1 - distance(window.sound, target) / longer;
      const seen = best.get(number);
      if (!seen || score > seen.score) best.set(number, { score, span: window.span });
    }
  }
  const ranked = [...best].sort((a, b) => b[1].score - a[1].score);
  const top = ranked[0];
  if (!top || top[1].score < PART_NUMBER_MIN_SOUND) return NONE;
  // A number heard exactly as said, sign for sign, is that number when no other is (04465-10010 beside 04465-10K010).
  if (top[1].score === 1 && (ranked[1]?.[1].score ?? 0) < 1)
    return { number: top[0], close: [top[0]], span: top[1].span };
  const close = ranked
    .filter(([, seen]) => seen.score >= top[1].score - PART_NUMBER_LEAD)
    .slice(0, 4)
    .map(([number]) => number);
  if (close.length === 1) return { number: top[0], close, span: top[1].span };
  const preferred = options.prefer ? close.filter(options.prefer) : [];
  if (preferred.length === 1) {
    const chosen = preferred[0]!;
    return { number: chosen, close, span: best.get(chosen)!.span };
  }
  return { number: null, close, span: top[1].span };
}

/**
 * A rack's letter and number said as one word ("বিটু" B-2, "সিওয়ান" C-1, D237): a spelled letter, then digit words.
 * Null for a word that is a number or sign itself, or splits no such way.
 */
export function gluedRack(token: string): string | null {
  if (exactSigns(token) !== null) return null;
  const word = nfc(token);
  let label: { key: string; cost: number } | null = null;
  for (let cut = 1; cut < word.length; cut += 1) {
    const letter = spokenSign(word.slice(0, cut));
    if (!letter || !/^[a-z]$/.test(letter)) continue;
    const digits = englishDigits(word.slice(cut));
    if (digits && /^\d{1,3}$/.test(digits.digits) && (!label || digits.cost < label.cost))
      label = { key: `${letter.toUpperCase()}${digits.digits}`, cost: digits.cost };
  }
  // A word read as digits alone with no more change is a number ("এইটনাইন", 89), not a rack ("এইচওয়ান" is H-1).
  const number = digitSplit(token);
  return label && (!number || label.cost < number.cost) ? label.key : null;
}

/** The English digit words, written exactly ("ওয়ান", "one"): a letter is glued to these, never to এক or ek. */
const ENGLISH_DIGIT_WORDS = new Map(
  Object.entries(spelled.digits).flatMap(([digit, words]) =>
    words.slice(0, 2).map((word) => [nfc(word), digit] as const),
  ),
);

/**
 * The digits of a rack's glued number: an English digit word written exactly ("টু", "ওয়ান", "two"), as speech-to-text
 * glued them in the run. Never by sound, so "জেনুইন" (genuine) is no J-9 ("নুইন" is a letter from নাইন), and never a
 * Bangla number word ("এক", "ek"), so "arek" (another) is no R-1.
 */
function englishDigits(rest: string): { digits: string; cost: number } | null {
  if (/^\d{1,3}$/.test(asciiDigits(rest))) return { digits: asciiDigits(rest), cost: 0 };
  const exact = ENGLISH_DIGIT_WORDS.get(rest);
  return exact ? { digits: exact, cost: 0 } : null;
}
