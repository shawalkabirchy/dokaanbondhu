import { matchConcept, type AliasConcept, type Dictionary, type GlossaryEntry } from "./glossary";
import { isNumberWord } from "./numbers";
import { keySimilarity, phoneticKey } from "./phonetic";
import { isBangla, normalize } from "./text";

// How each shop learns its own words (D102, D105): the listening check writes down how speech-to-text spells the shop's
// car and part names, and answered questions show how a name was heard. Both give suggestions the owner adds as the
// shop's aliases (or dismisses); these rules decide which words are worth suggesting.

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

/**
 * The carrier word of the listening check ("… আছে?") as speech-to-text writes it (আছে, আছি, আছেই, আছেন; Banglish
 * ache, achi), dropped from what was heard.
 */
const CARRIER = /^(আছ\S*|ach\S*|কি|ki)$/;

/**
 * What the listening check suggests from one name's speech-to-text hypotheses (D102 A, D105): of the best two, without
 * the carrier word, the spellings that are learnable, sound at least half like the name (so a wild guess is never
 * kept), and are not already understood as this name by the matcher (no need to suggest those).
 */
export function checkedSpellings(
  spoken: string,
  hypotheses: readonly string[],
  dictionary: Dictionary,
  target?: { concept: AliasConcept; value: string },
): { heard: string[]; keep: string[] } {
  const spokenKey = phoneticKey(normalize(spoken, dictionary.variants).tokens.join(" "));
  const heard: string[] = [];
  const keep: string[] = [];
  for (const hypothesis of hypotheses.slice(0, 2)) {
    const tokens = normalize(hypothesis, dictionary.variants).tokens;
    while (tokens.length > 1 && CARRIER.test(tokens.at(-1)!)) tokens.pop();
    const text = tokens.join(" ");
    if (!text || heard.includes(text)) continue;
    heard.push(text);
    const words = learnableWords(text, dictionary);
    if (!words || keep.includes(words) || keySimilarity(phoneticKey(words), spokenKey) < 0.5) continue;
    if (target) {
      const match = matchConcept(target.concept, words, [], dictionary);
      if (match.decision === "understood" && match.candidates[0]?.value === target.value) continue;
    }
    keep.push(words);
  }
  return { heard, keep };
}
