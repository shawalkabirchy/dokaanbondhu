import words from "../data/price-tiers.json";

// A customer's price level as a shop app names it (D121): "Garage", "MECHANIC", "dealer", "পাইকারি" ... The word
// list is shared by every host; a value it does not know is asked once in setup, and the owner's answer wins.

export type PriceTier = "retail" | "garage" | "wholesale";

const PRICE_TIERS: readonly PriceTier[] = ["retail", "garage", "wholesale"];

/** Lower case, NFC, dashes and underscores as spaces, single spaces ("Walk-In_Customer" -> "walk in customer"). */
function plain(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[-_./]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const BY_WORD = new Map<string, PriceTier>();
for (const tier of PRICE_TIERS) for (const word of words.tiers[tier]) BY_WORD.set(plain(word), tier);
const FILLER = new Set(words.filler.map(plain));

/** The price level a host's value names, or null when the word list does not know it. */
export function priceTierOf(value: string | null | undefined): PriceTier | null {
  if (!value) return null;
  const said = plain(value);
  if (!said) return null;
  const known = BY_WORD.get(said);
  if (known) return known;
  // "Garage price", "wholesale customer": the words around the level are left out.
  const core = said
    .split(" ")
    .filter((word) => !FILLER.has(word))
    .join(" ");
  return core ? (BY_WORD.get(core) ?? null) : null;
}

export function isPriceTier(value: unknown): value is PriceTier {
  return typeof value === "string" && (PRICE_TIERS as readonly string[]).includes(value);
}
