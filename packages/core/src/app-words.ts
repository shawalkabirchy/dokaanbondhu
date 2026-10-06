import words from "../data/app-words.json";

// The words a shop app writes for a customer's price level and a part's quality, position and unit (D121, D122):
// "Garage", "MECHANIC", "Dealer", "পাইকারি"; "OEM", "Copy"; "F", "FL", "Rear"; "pcs", "ltr". The word list is shared by
// every host; a value it does not know is asked once in setup, and the owner's answer wins.

export type AppWordConcept = "price_tier" | "quality" | "position" | "unit";
export const APP_WORD_CONCEPTS: readonly AppWordConcept[] = ["price_tier", "quality", "position", "unit"];

/** Our values of each concept, the ones the owner may choose in setup. */
export const APP_WORD_VALUES: Record<AppWordConcept, readonly string[]> = {
  price_tier: ["retail", "garage", "wholesale"],
  quality: ["genuine", "aftermarket", "reconditioned", "used"],
  position: ["front", "rear", "left", "right"],
  unit: ["piece", "set", "pair", "hali", "dozen", "liter", "tin", "box"],
};

export type PriceTier = "retail" | "garage" | "wholesale";

/** Lower case, NFC, dashes, slashes, dots and underscores as spaces, single spaces ("Walk-In_Customer" -> "walk in customer"). */
function plain(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[-_./]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FILLER = new Set(words.filler.map(plain));
const BY_WORD = new Map<AppWordConcept, Map<string, string>>(
  APP_WORD_CONCEPTS.map((concept) => {
    const byWord = new Map<string, string>();
    for (const [value, spellings] of Object.entries(words[concept] as Record<string, string[]>)) {
      for (const spelling of [value, ...spellings]) byWord.set(plain(spelling), value);
    }
    return [concept, byWord];
  }),
);

/**
 * Our value for a host's word, or null when the list does not know it. A position may be two values, space-separated
 * in a fixed order ("front left").
 */
export function appWord(concept: AppWordConcept, value: string | null | undefined): string | null {
  if (!value) return null;
  const said = plain(value);
  if (!said) return null;
  const byWord = BY_WORD.get(concept)!;
  const known = byWord.get(said);
  if (known) return known;
  // "Garage price", "OEM grade", "Front side": the words around the value are left out.
  const core = said
    .split(" ")
    .filter((word) => !FILLER.has(word))
    .join(" ");
  return core ? (byWord.get(core) ?? null) : null;
}

/** Whether a value is one of ours for the concept (an owner's choice in setup). */
export function isAppWordValue(concept: AppWordConcept, value: unknown): value is string {
  return typeof value === "string" && APP_WORD_VALUES[concept].includes(value);
}

/** The price level a host's value names, or null when the word list does not know it. */
export function priceTierOf(value: string | null | undefined): PriceTier | null {
  return appWord("price_tier", value) as PriceTier | null;
}

export function isPriceTier(value: unknown): value is PriceTier {
  return isAppWordValue("price_tier", value);
}

/** The single positions of a position value ("front left" -> front, left). */
export function positionsOf(value: string | null): string[] {
  return value ? value.split(" ") : [];
}
