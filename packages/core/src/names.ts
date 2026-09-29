import type { Dictionary } from "./glossary";
import { normalizePartNumber, spokenSign } from "./numbers";
import { keySimilarity, phoneticKey } from "./phonetic";
import { asciiDigits, normalize } from "./text";

// The shop's own names said inside a request (spec 9.1, D95, D108): its customers and suppliers in either script and
// with an ending ("নিউ ঢাকা গ্যারেজের" is New Dhaka Garage), and its rack labels however they were said ("সি-২",
// "c 2" and "C2" are C-2). They go to the LLM as candidates, so it looks in the right table with the stored spelling.

export interface NamedInText {
  kind: string;
  name: string;
  /** The words of the request that said it. */
  heard: string;
  score: number;
}

/** How alike a said name must sound, on keys of three letters or more; anything less is left to the LLM. */
const NAME_SIMILARITY = 0.8;

/** Every way to read a run of tokens: each token as said or without its ending. */
function readings(forms: readonly string[][], start: number, size: number): string[] {
  let combos: string[][] = [[]];
  for (let index = start; index < start + size; index += 1)
    combos = combos.flatMap((combo) => (forms[index] ?? []).map((form) => [...combo, form]));
  return combos.map((combo) => combo.join(" "));
}

/**
 * The names said in the text: a run of as many words as the name, the same after normalizing or sounding alike (key
 * similarity 0.8 or more). The best `limit` of each kind, best first.
 */
export function namesInText(
  text: string,
  names: readonly { kind: string; name: string }[],
  dictionary: Dictionary,
  limit = 3,
): NamedInText[] {
  const said = normalize(text, dictionary.variants);
  const found: NamedInText[] = [];
  for (const { kind, name } of names) {
    const tokens = normalize(name, dictionary.variants).tokens;
    if (!tokens.length || tokens.length > said.tokens.length) continue;
    const nameText = tokens.join(" ");
    const nameKey = phoneticKey(nameText);
    let best: NamedInText | null = null;
    for (let start = 0; start + tokens.length <= said.tokens.length; start += 1) {
      for (const reading of readings(said.forms, start, tokens.length)) {
        const key = phoneticKey(reading);
        const score =
          reading === nameText
            ? 1
            : Math.min(key.length, nameKey.length) >= 3
              ? keySimilarity(key, nameKey)
              : 0;
        if (score < NAME_SIMILARITY || (best && best.score >= score)) continue;
        best = { kind, name, heard: said.tokens.slice(start, start + tokens.length).join(" "), score };
      }
    }
    if (best) found.push(best);
  }
  found.sort((a, b) => b.score - a.score);
  const kept = new Map<string, number>();
  return found.filter((named) => {
    const count = kept.get(named.kind) ?? 0;
    kept.set(named.kind, count + 1);
    return count < limit;
  });
}

/** A rack label for comparing: upper case, without spaces, dashes, dots or slashes ("C-2", "c 2" -> "C2"). */
const rackKey = (label: string) => normalizePartNumber(label);

/**
 * The shop's rack labels said in the text, written ("C-2", "c2", "c 2") or spelled ("সি ২", "see two"): a run of up to
 * three signs whose letters and digits are a label's. Only labels with a letter and a digit are looked for.
 */
export function racksInText(text: string, racks: readonly string[]): NamedInText[] {
  const byKey = new Map<string, string>();
  for (const rack of racks) {
    const key = rackKey(rack);
    if (/[A-Z]/.test(key) && /\d/.test(key) && !byKey.has(key)) byKey.set(key, rack);
  }
  if (!byKey.size) return [];
  const tokens = normalize(text).tokens;
  const signs = tokens.map(
    (token) => spokenSign(token) ?? (/^[a-z0-9][a-z0-9./-]*$/.test(asciiDigits(token)) ? token : null),
  );
  const found = new Map<string, NamedInText>();
  for (let start = 0; start < signs.length; start += 1) {
    let run = "";
    for (let size = 1; size <= 3 && start + size <= signs.length; size += 1) {
      const sign = signs[start + size - 1];
      if (sign === null || sign === undefined) break;
      run += sign;
      const rack = byKey.get(rackKey(run));
      if (rack && !found.has(rack))
        found.set(rack, {
          kind: "rack",
          name: rack,
          heard: tokens.slice(start, start + size).join(" "),
          score: 1,
        });
    }
  }
  return [...found.values()];
}
