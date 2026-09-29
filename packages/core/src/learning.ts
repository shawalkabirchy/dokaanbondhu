import { type AliasConcept, type Dictionary, type GlossaryEntry } from "./glossary";
import { isNumberWord } from "./numbers";
import { keySimilarity, phoneticKey } from "./phonetic";
import { isBangla, normalize } from "./text";

// How each shop learns its own words (D102): the listening check writes down how speech-to-text spells the shop's car
// and part names, and answered questions show how a name was heard. Both give words that become the shop's aliases;
// these rules decide which words are safe to keep.

/** A shop's alias rows as glossary entries, so they join the dictionary (Bangla spellings apart from Latin ones). */
export function aliasEntries(
  rows: readonly { aliasText: string; targetConcept: string; targetValue: string }[],
): GlossaryEntry[] {
  return rows.map((row) => {
    const bangla = isBangla(row.aliasText);
    return {
      target_concept: row.targetConcept as AliasConcept,
      target_value: row.targetValue,
      bn: bangla ? [row.aliasText] : [],
      latin: bangla ? [] : [row.aliasText.toLowerCase()],
    };
  });
}

/**
 * The normalized words, when they may become an alias of a target; else null. Not kept: nothing or more than four
 * words; only number words ("এক", "দুই হাজার"); a phonetic key under two letters (too short to tell apart);
 * words the dictionary already has for any target (nothing to learn, or they would take a name from another target).
 */
export function learnableWords(heard: string, dictionary: Dictionary): string | null {
  const tokens = normalize(heard, dictionary.variants).tokens;
  if (tokens.length === 0 || tokens.length > 4) return null;
  if (tokens.every(isNumberWord)) return null;
  const text = tokens.join(" ");
  if (phoneticKey(text).length < 2) return null;
  if (dictionary.terms.some((term) => term.text === text)) return null;
  return text;
}

/** Words the carrier phrase of the listening check adds after the name ("… আছে?"), dropped from what was heard. */
const CARRIER = /^(আছে|আছেন|আছে কি|ache|achhe)$/;

/**
 * What the listening check keeps from one name's speech-to-text hypotheses (D102 A): the best two, without the
 * carrier word, that are learnable and sound at least half like the name (so a wild guess is never kept).
 */
export function checkedSpellings(
  spoken: string,
  hypotheses: readonly string[],
  dictionary: Dictionary,
): { heard: string[]; keep: string[] } {
  const spokenKey = phoneticKey(normalize(spoken, dictionary.variants).tokens.join(" "));
  const heard: string[] = [];
  const keep: string[] = [];
  for (const hypothesis of hypotheses.slice(0, 2)) {
    const tokens = normalize(hypothesis, dictionary.variants).tokens;
    while (tokens.length && CARRIER.test(tokens.at(-1)!)) tokens.pop();
    const text = tokens.join(" ");
    if (!text || heard.includes(text)) continue;
    heard.push(text);
    const words = learnableWords(text, dictionary);
    if (words && keySimilarity(phoneticKey(words), spokenKey) >= 0.5 && !keep.includes(words))
      keep.push(words);
  }
  return { heard, keep };
}
