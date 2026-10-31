import globalEntries from "../data/glossary.json";
import {
  decide,
  keySimilarity,
  matchScore,
  NBEST_WEIGHTS,
  phoneticKey,
  type Understanding,
} from "./phonetic";
import { isNumberWord } from "./numbers";
import { normalize, type Normalized } from "./text";

// Alias dictionary (spec 10.2): the global glossary plus the shop's aliases (owner-added and imported from the host).

/** customer and supplier: a name as speech-to-text writes it, learned from corrections (D155); never in the global glossary. */
export const ALIAS_CONCEPTS = [
  "part_type",
  "vehicle_model",
  "quality",
  "position",
  "unit",
  "brand",
  "customer",
  "supplier",
] as const;
export type AliasConcept = (typeof ALIAS_CONCEPTS)[number];

export interface GlossaryEntry {
  target_concept: AliasConcept;
  target_value: string;
  bn: string[];
  latin: string[];
}

/** One spelling of one target, ready for matching. */
export interface Term {
  concept: AliasConcept;
  value: string;
  text: string; // normalized, tokens joined by one space
  key: string; // phonetic key
}

export interface Dictionary {
  terms: Term[];
  /** Banglish spelling variants mapped to one form (spec 10.1, step 3). */
  variants: Map<string, string>;
}

export const GLOSSARY = globalEntries as GlossaryEntry[];

/** Builds the dictionary from glossary entries (global first, then the shop's aliases). */
export function buildDictionary(entries: readonly GlossaryEntry[] = GLOSSARY): Dictionary {
  const variants = new Map<string, string>();
  for (const entry of entries) {
    const single = entry.latin.filter((spelling) => !/\s/.test(spelling));
    const first = single[0];
    if (!first) continue;
    for (const spelling of single) if (!variants.has(spelling)) variants.set(spelling, first);
  }
  const terms: Term[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const spelling of [...entry.bn, ...entry.latin, entry.target_value]) {
      const text = normalize(spelling, variants).tokens.join(" ");
      const id = `${entry.target_concept}\u0000${entry.target_value}\u0000${text}`;
      if (!text || seen.has(id)) continue;
      seen.add(id);
      terms.push({ concept: entry.target_concept, value: entry.target_value, text, key: phoneticKey(text) });
    }
  }
  return { terms, variants };
}

export interface Candidate {
  value: string;
  score: number;
  exact: boolean;
  /** The words matched, as heard. */
  heard: string;
}

export interface ConceptMatch {
  candidates: Candidate[]; // best first
  decision: Understanding;
}

/** The word sequences of one text, n-grams of up to three tokens, longest first, each token as it is or without its ending. */
function* ngrams(
  normalized: Normalized,
): Generator<{ text: string; heard: string; start: number; size: number }> {
  const { forms, tokens } = normalized;
  for (let size = Math.min(3, tokens.length); size >= 1; size -= 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      const heard = tokens.slice(start, start + size).join(" ");
      let combos: string[][] = [[]];
      for (let index = start; index < start + size; index += 1) {
        combos = combos.flatMap((combo) => (forms[index] ?? []).map((form) => [...combo, form]));
      }
      for (const combo of combos) yield { text: combo.join(" "), heard, start, size };
    }
  }
}

const KNOWN = new WeakMap<Dictionary, ReadonlySet<string>>();

/** Every word of every term of the dictionary, whatever its concept: ফিল্টার, ব্রেক, এক্সিও. */
export function knownWords(dictionary: Dictionary): ReadonlySet<string> {
  let known = KNOWN.get(dictionary);
  if (!known) {
    known = new Set(dictionary.terms.flatMap((term) => term.text.split(" ")));
    KNOWN.set(dictionary, known);
  }
  return known;
}

/** How close a word of another hypothesis must sound to the said value to count as the same spoken place. */
const SAME_PLACE = 0.5;
/** A match of several words this good takes its words from shorter matches (D152). */
const TAKES_ITS_WORDS = 0.7;

/** Which ends of several words are number words ("start", "end", "both"), or null: the edges of "এক জিও" are "start". */
function numberEdges(words: readonly string[]): "start" | "end" | "both" | null {
  if (words.length < 2) return null;
  const start = isNumberWord(words[0]!);
  const end = isNumberWord(words.at(-1)!);
  return start && end ? "both" : start ? "start" : end ? "end" : null;
}

/** Words for paying by bKash: they sound like Voxy (both "bks"), so they match a term only exactly (D212). */
const NEVER_BY_SOUND = new Set([
  "বিকাশ",
  "বিকাশে",
  "বিকাশের",
  "bkash",
  "bkashe",
  "bkasher",
  "bikash",
  "bikashe",
  "bikasher",
]);

/**
 * Scores the targets of one concept for a slot value as said (the tool argument, from the best hypothesis) and the
 * other N-best hypotheses (rank order, rank 0 first). Words of the hypotheses count only where they sound like the
 * said value, so "fit" in "axio 2014 e fit hobe" is not taken for Honda Fit. An exact normalized match scores 1.0,
 * else 0.9 x phonetic similarity (0 below 0.6), times the rank's weight; a candidate keeps its best score. Keys
 * shorter than two letters are not matched phonetically, two-letter keys only between single words (D108), and words
 * made only of number words ("এক", "ek", "হাজার") never: "এক" sounds like Aqua's "একুয়া" (D101). Nor a word for bKash
 * (D212).
 */
export function matchConcept(
  concept: AliasConcept,
  said: string,
  hypotheses: readonly string[],
  dictionary: Dictionary,
): ConceptMatch {
  const terms = dictionary.terms.filter((term) => term.concept === concept);
  const termEdges = new Map(terms.map((term) => [term, numberEdges(term.text.split(" "))]));
  const known = knownWords(dictionary);
  const best = new Map<string, Candidate>();
  const saidKey = phoneticKey(normalize(said, dictionary.variants).tokens.join(" "));
  const sources: { text: string; weight: number; nearSaid: boolean }[] = [
    { text: said, weight: NBEST_WEIGHTS[0], nearSaid: false },
    ...hypotheses
      .slice(0, NBEST_WEIGHTS.length)
      .map((text, rank) => ({ text, weight: NBEST_WEIGHTS[rank] ?? 0, nearSaid: true })),
  ];
  for (const source of sources) {
    const normalized = normalize(source.text, dictionary.variants);
    // Words a match of more words has taken: "জেনুইন" in "নন জেনুইন" is not also genuine (spec 10.2, longest first;
    // D136), nor "জ্যানুইন" in the misheard "নন জ্যানুইন", nor "ব্রেক" in "ব্রেক ব্যাট" another brake part (D152).
    // Words a match by sound has taken still match a term exactly: "অয়েল ফিল্টার" in "অয়েল ফিল্টার আছে" (D158).
    const takenExact: [number, number][] = [];
    const takenNear: [number, number][] = [];
    for (const gram of ngrams(normalized)) {
      const end = gram.start + gram.size;
      const inside = (spans: [number, number][]) =>
        spans.some(([from, to]) => gram.start >= from && end <= to && gram.size < to - from);
      if (inside(takenExact)) continue;
      const onlyExact = inside(takenNear);
      const key = phoneticKey(gram.text);
      if (source.nearSaid && keySimilarity(key, saidKey) < SAME_PLACE) continue;
      const words = gram.text.split(" ");
      const numeric = words.every(isNumberWord);
      const exactOnly = numeric || words.some((word) => NEVER_BY_SOUND.has(word));
      // Several words that start or end with a number word match by sound only a term that does too: "তেরো ইয়াল
      // ফিল্ডার" (the year, then "air filter") is not "তেল ফিল্টার", nor "প্রোবক্স দুই" a car, but "এক জি ও" is still
      // "এক জিও" (D158).
      const edges = numberEdges(words);
      // Near sounds count half only for a word no term knows: a misheard one (D152).
      const misheard = words.some((word) => !known.has(word));
      const weight = source.weight;
      let gramBest = 0;
      for (const term of terms) {
        const exact = gram.text === term.text;
        if (exact) takenExact.push([gram.start, end]);
        else if (onlyExact) continue;
        // A two-letter key is too little to go on beyond one word: "toyota aqua" is "tk", and so are "তাকে কী" and
        // "টাকা"; "e ki ki" is Aqua's "ek" (D108).
        const tooShort =
          Math.min(key.length, term.key.length) <= 2 && (words.length > 1 || term.text.includes(" "));
        const otherEdges = edges && edges !== termEdges.get(term);
        const similarity =
          exact || exactOnly || otherEdges || tooShort || key.length < 2 || term.key.length < 2
            ? 0
            : keySimilarity(key, term.key, misheard);
        const score = weight * matchScore(exact, similarity);
        gramBest = Math.max(gramBest, score);
        if (score <= 0) continue;
        const current = best.get(term.value);
        if (!current || score > current.score) {
          best.set(term.value, { value: term.value, score, exact, heard: gram.heard });
        }
      }
      if (gram.size > 1 && gramBest >= TAKES_ITS_WORDS && !onlyExact) takenNear.push([gram.start, end]);
    }
  }
  const candidates = [...best.values()].sort((a, b) => b.score - a.score);
  return { candidates, decision: decide(candidates[0]?.score ?? 0, candidates[1]?.score ?? 0) };
}
