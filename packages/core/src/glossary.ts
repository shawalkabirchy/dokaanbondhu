import globalEntries from "../data/glossary.json";
import {
  decide,
  keySimilarity,
  matchScore,
  NBEST_WEIGHTS,
  phoneticKey,
  type Understanding,
} from "./phonetic";
import { normalize, type Normalized } from "./text";

// Alias dictionary (spec 10.2): the global glossary plus the shop's aliases (owner-added and imported from the host).

export const ALIAS_CONCEPTS = ["part_type", "vehicle_model", "quality", "position", "unit", "brand"] as const;
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

/** The word sequences of one text, n-grams of up to three tokens, each token as it is or without its ending. */
function* ngrams(normalized: Normalized): Generator<{ text: string; heard: string }> {
  const { forms, tokens } = normalized;
  for (let size = Math.min(3, tokens.length); size >= 1; size -= 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      const heard = tokens.slice(start, start + size).join(" ");
      let combos: string[][] = [[]];
      for (let index = start; index < start + size; index += 1) {
        combos = combos.flatMap((combo) => (forms[index] ?? []).map((form) => [...combo, form]));
      }
      for (const combo of combos) yield { text: combo.join(" "), heard };
    }
  }
}

/** How close a word of another hypothesis must sound to the said value to count as the same spoken place. */
const SAME_PLACE = 0.5;

/**
 * Scores the targets of one concept for a slot value as said (the tool argument, from the best hypothesis) and the
 * other N-best hypotheses (rank order, rank 0 first). Words of the hypotheses count only where they sound like the
 * said value, so "fit" in "axio 2014 e fit hobe" is not taken for Honda Fit. An exact normalized match scores 1.0,
 * else 0.9 x phonetic similarity (0 below 0.6), times the rank's weight; a candidate keeps its best score. Keys
 * shorter than two letters are not matched phonetically.
 */
export function matchConcept(
  concept: AliasConcept,
  said: string,
  hypotheses: readonly string[],
  dictionary: Dictionary,
): ConceptMatch {
  const terms = dictionary.terms.filter((term) => term.concept === concept);
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
    for (const gram of ngrams(normalized)) {
      const key = phoneticKey(gram.text);
      if (source.nearSaid && keySimilarity(key, saidKey) < SAME_PLACE) continue;
      const weight = source.weight;
      for (const term of terms) {
        const exact = gram.text === term.text;
        const similarity = exact || key.length < 2 || term.key.length < 2 ? 0 : keySimilarity(key, term.key);
        const score = weight * matchScore(exact, similarity);
        if (score <= 0) continue;
        const current = best.get(term.value);
        if (!current || score > current.score) {
          best.set(term.value, { value: term.value, score, exact, heard: gram.heard });
        }
      }
    }
  }
  const candidates = [...best.values()].sort((a, b) => b.score - a.score);
  return { candidates, decision: decide(candidates[0]?.score ?? 0, candidates[1]?.score ?? 0) };
}
