import { appWord } from "./app-words";
import { buildDictionary, matchConcept, type Dictionary, type GlossaryEntry } from "./glossary";
import { isNumberWord } from "./numbers";
import { isModel, type CatalogPart, type CatalogVehicle } from "./resolve";
import { normalize } from "./text";

// The shop's own vocabulary, from its app's data (D122): its car models that the glossary does not have, its part
// categories, and the part kind in each part name that names no known type ("Brake master cylinder repair kit" is a
// Brake Master Cylinder). They are English as the app writes them and understood at once; their Bangla spellings still
// come from the listening check and wait for the owner (D105).

/** Words around a part kind in a name that are not the kind: "Brake master cylinder repair kit". */
const NOT_KIND = new Set([
  "for",
  "with",
  "and",
  "of",
  "the",
  "to",
  "kit",
  "repair",
  "assy",
  "assembly",
  "complete",
  "new",
  "old",
  "stock",
  "type",
  "size",
  "model",
  "only",
  "fits",
  "fit",
  // measures
  "ml",
  "ltr",
  "kg",
  "gm",
  "gram",
  "mm",
  "cm",
  "inch",
  "volt",
  "watt",
  "amp",
]);
const MAX_KIND_WORDS = 4;

const tokensOf = (text: string) => normalize(text).tokens;

/** The words of a text kept as the app writes them ("AC Compressor"), those whose normalized form is kept. */
function asWritten(text: string, keep: readonly string[]): string {
  const wanted = new Set(keep);
  return text
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, ""))
    .filter((word) => {
      const tokens = tokensOf(word);
      return tokens.length === 1 && wanted.has(tokens[0]!);
    })
    .join(" ");
}

/**
 * A chassis or engine code inside a car name: two letters or more and two digits or more together ("NZE141",
 * "AE100", "GRS180"), never a model's own name ("H6", "RAV4", "CX-5", "i20").
 */
const isCode = (word: string) =>
  (word.match(/[a-z]/gi) ?? []).length >= 2 && (word.match(/\d/g) ?? []).length >= 2 && !/-/.test(word);

/** A car's name for the dictionary: its make and model without codes ("Crown GRS180" -> "Crown"). */
function carName(vehicle: CatalogVehicle): string {
  const words = `${vehicle.make} ${vehicle.model}`.trim().split(/\s+/);
  const kept = words.filter((word) => !isCode(word));
  return (kept.length ? kept : words).join(" ");
}

/** The dictionary value of an app's car: the glossary model it is (keeping its Bangla words), else its own name. */
export function vehicleValue(vehicle: CatalogVehicle, base: Dictionary): string {
  const glossary = [
    ...new Set(base.terms.filter((term) => term.concept === "vehicle_model").map((term) => term.value)),
  ];
  return glossary.find((value) => isModel(vehicle, value)) ?? carName(vehicle);
}

function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (!needle.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

/**
 * Glossary entries for the shop's own names. A category or name kind that already sounds like a glossary part type
 * (understood, not only bold) becomes another spelling of it ("Brake Pads"); the rest are new types.
 */
export function catalogEntries(
  catalog: { parts: readonly CatalogPart[]; vehicles: readonly CatalogVehicle[] },
  base: Dictionary = buildDictionary(),
): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  const seen = new Set<string>();
  const add = (concept: GlossaryEntry["target_concept"], value: string, spelling: string) => {
    const id = `${concept}|${value}|${spelling.toLowerCase()}`;
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({ target_concept: concept, target_value: value, bn: [], latin: [spelling] });
  };

  // Cars the glossary does not have: "Hyundai Tucson", also said as "Tucson".
  for (const vehicle of catalog.vehicles) {
    const value = vehicleValue(vehicle, base);
    if (base.terms.some((term) => term.concept === "vehicle_model" && term.value === value)) continue;
    add("vehicle_model", value, value);
    const model = carName({ ...vehicle, make: "" });
    if (model && model !== value) add("vehicle_model", value, model);
    // "Pulsar" for the Pulsar 150, when a word of three letters or more is left.
    const words = model.split(" ");
    const named = words.filter((word) => !/^\d+$/.test(word));
    if (named.length < words.length && named.some((word) => word.length >= 3))
      add("vehicle_model", value, named.join(" "));
  }

  // A kind or category as a part type: a glossary type when it is one, a plural allowed ("Brake Pads"), never only by
  // sound ("Brakes" is not Brake Shoe); else its own.
  const exactType = (phrase: string) => {
    const best = matchConcept("part_type", phrase, [], base).candidates[0];
    return best?.exact ? best.value : null;
  };
  const addKind = (words: string[], written: string) => {
    const phrase = words.join(" ");
    if (exactType(phrase)) return;
    const singular = [...words.slice(0, -1), words.at(-1)!.replace(/(?<=[a-z]{3})e?s$/, "")].join(" ");
    const glossary = singular !== phrase ? exactType(singular) : null;
    add("part_type", glossary ?? (written || phrase), phrase);
  };
  const categories = new Set<string>();
  for (const part of catalog.parts) {
    const category = part.category?.trim();
    if (category && !categories.has(category.toLowerCase())) {
      categories.add(category.toLowerCase());
      addKind(tokensOf(category), category.replace(/\s+/g, " "));
    }
  }

  // Part names naming no known type: the words left once cars, sides, grades, units, brands, numbers and codes are
  // taken out are the kind.
  const known = buildDictionary([...entries]).terms.concat(base.terms);
  const typeSpellings = known
    .filter((term) => term.concept === "part_type")
    .map((term) => term.text.split(" "));
  const otherWords = new Set(
    known.filter((term) => term.concept !== "part_type").flatMap((term) => term.text.split(" ")),
  );
  for (const vehicle of catalog.vehicles)
    for (const word of tokensOf(`${vehicle.make} ${vehicle.model}`)) otherWords.add(word);
  for (const part of catalog.parts) {
    const words = tokensOf(part.name);
    if (typeSpellings.some((spelling) => containsRun(words, spelling))) continue;
    const kind = words.filter(
      (word) =>
        word.length > 1 &&
        !/\d/.test(word) &&
        !isNumberWord(word) &&
        !NOT_KIND.has(word) &&
        !otherWords.has(word) &&
        !appWord("position", word) &&
        !appWord("quality", word) &&
        !appWord("unit", word),
    );
    if (!kind.some((word) => word.length >= 3)) continue;
    const kept = kind.slice(0, MAX_KIND_WORDS);
    addKind(kept, asWritten(part.name, kept));
  }
  return entries;
}
