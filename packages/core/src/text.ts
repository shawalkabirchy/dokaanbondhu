import suffixes from "../data/bn-suffixes.json";

// Text normalization (spec 10.1): the tokens used for matching. The original text is kept for display.

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
/** Zero-width space, non-joiner, joiner, word joiner and byte order mark. */
export const ZERO_WIDTH_CHARS = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((code) =>
  String.fromCodePoint(code),
);
const ZERO_WIDTH = new RegExp(`[${ZERO_WIDTH_CHARS.join("")}]`, "g");
const BANGLA = /[ঀ-৿]/;
// Private-use placeholders keep - / and . through the punctuation step.
const KEEP_DASH = String.fromCodePoint(0xe000);
const KEEP_SLASH = String.fromCodePoint(0xe001);
const KEEP_POINT = String.fromCodePoint(0xe002);

export function isBangla(text: string): boolean {
  return BANGLA.test(text);
}

/** Bangla digits to ASCII digits (display keeps the Bangla ones). */
export function asciiDigits(text: string): string {
  return text.replace(/[০-৯]/g, (digit) => String(BN_DIGITS.indexOf(digit)));
}

/** ASCII digits to Bangla digits, for display. */
export function banglaDigits(text: string): string {
  return text.replace(/[0-9]/g, (digit) => BN_DIGITS[Number(digit)] ?? digit);
}

export interface Normalized {
  /** The text as typed or heard, for display. */
  text: string;
  /** Normalized tokens. */
  tokens: string[];
  /** Per token: the token itself, then the token with one grammatical ending removed (if any). */
  forms: string[][];
}

/**
 * Normalizes one text. `variants` maps a Banglish spelling variant to its one form (built from the glossary,
 * spec 10.2), for example samne and shamne to samner.
 */
export function normalize(text: string, variants: ReadonlyMap<string, string> = new Map()): Normalized {
  let clean = asciiDigits(text.normalize("NFC").replace(ZERO_WIDTH, "")).toLowerCase();
  // Punctuation becomes a space, except - and / inside part numbers and rack labels (04465-10010, B-3, 5W-30)
  // and a decimal point between digits (1.5 liter). A Bangla ending after a dash splits off (২০১৪-এর).
  clean = clean
    .replace(/(?<=[a-z0-9])[-/](?=[a-z0-9])/g, (mark) => (mark === "-" ? KEEP_DASH : KEEP_SLASH))
    .replace(/(?<=\d)\.(?=\d)/g, KEEP_POINT)
    .replace(/[^\p{L}\p{M}\p{N}\p{Co}]+/gu, " ")
    .split(KEEP_DASH)
    .join("-")
    .split(KEEP_SLASH)
    .join("/")
    .split(KEEP_POINT)
    .join(".")
    .trim();
  const tokens = clean
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (isBangla(token)) return token;
      const squeezed = token.replace(/(\p{L})\1{2,}/gu, "$1"); // acheee -> ache
      return variants.get(squeezed) ?? squeezed;
    });
  return { text, tokens, forms: tokens.map((token) => [token, ...stripEnding(token)]) };
}

/** The token with one grammatical ending removed, if it has one and something meaningful is left. */
export function stripEnding(token: string): string[] {
  const bangla = isBangla(token);
  const endings = bangla ? suffixes.bn : suffixes.latin;
  const minimum = bangla ? 2 : 3;
  for (const ending of endings) {
    if (token.length - ending.length >= minimum && token.endsWith(ending)) {
      return [token.slice(0, -ending.length)];
    }
  }
  return [];
}
