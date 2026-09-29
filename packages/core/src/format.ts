import numbers from "../data/bn-numbers.json";
import { asciiDigits, banglaDigits } from "./text";

// Numbers in answers (spec 10.8). The grouping is the same algorithm as the first host app's taka formatter,
// re-implemented here (no dependency between the repositories).

/** Bangladeshi grouping: the last three digits, then groups of two (12,34,567). */
function groupDigits(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${head},${digits.slice(-3)}`;
}

/** Paisa as whole taka, rounded half away from zero (D92): "4,500", "1,23,457"; with Bangla digits by default. */
export function formatTaka(paisa: bigint, options: { bangla?: boolean } = {}): string {
  const taka = wholeTaka(paisa);
  const sign = taka < 0n ? "-" : "";
  const text = `${sign}${groupDigits((taka < 0n ? -taka : taka).toString())}`;
  return options.bangla === false ? text : banglaDigits(text);
}

/** Paisa to whole taka, half away from zero: paisa are never shown or said (D92). */
export function wholeTaka(paisa: bigint): bigint {
  const absolute = paisa < 0n ? -paisa : paisa;
  const taka = (absolute + 50n) / 100n;
  return paisa < 0n ? -taka : taka;
}

/** Money as spoken and shown: "৪,২০০ টাকা". */
export function money(paisa: bigint): string {
  return `${formatTaka(paisa)} টাকা`;
}

/** A year as plain digits: "২০১৪". */
export function year(value: number): string {
  return banglaDigits(String(value));
}

const UNIT_BN: Record<string, string> = {
  piece: "টা",
  set: "সেট",
  pair: "জোড়া",
  liter: "লিটার",
  tin: "টিন",
  box: "বক্স",
  hali: "হালি",
  dozen: "ডজন",
};

/** A quantity with its unit word: "২ সেট", "৩টা", "১.৫ লিটার". */
export function quantity(value: number, unit: string): string {
  const number = banglaDigits(String(value));
  const word = UNIT_BN[unit] ?? unit;
  return unit === "piece" ? `${number}${word}` : `${number} ${word}`;
}

/** The Bangla word of 0 to 100: the first spelling of each in the number words. */
const WORD_OF: ReadonlyMap<number, string> = (() => {
  const words = new Map<number, string>();
  for (const [word, value] of Object.entries(numbers.bn)) if (!words.has(value)) words.set(value, word);
  return words;
})();

/** A whole number in Bangla words, with crore, lakh, thousand and hundred: 3530556 -> "পঁয়ত্রিশ লাখ ত্রিশ হাজার পাঁচশো ছাপ্পান্ন". */
export function numberWords(value: number): string {
  if (value < 100) return WORD_OF.get(value)!;
  const parts: string[] = [];
  const crore = Math.floor(value / 10_000_000);
  const lakh = Math.floor((value % 10_000_000) / 100_000);
  const thousand = Math.floor((value % 100_000) / 1_000);
  const hundred = Math.floor((value % 1_000) / 100);
  const rest = value % 100;
  if (crore) parts.push(`${numberWords(crore)} কোটি`);
  if (lakh) parts.push(`${WORD_OF.get(lakh)} লাখ`);
  if (thousand) parts.push(`${WORD_OF.get(thousand)} হাজার`);
  if (hundred) parts.push(`${WORD_OF.get(hundred)}শো`);
  if (rest) parts.push(WORD_OF.get(rest)!);
  return parts.join(" ");
}

/** A year as said: 2014 -> "দুই হাজার চৌদ্দ", 1999 -> "উনিশশো নিরানব্বই". */
function yearWords(value: number): string {
  const rest = value % 100;
  if (value < 2000) return rest ? `উনিশশো ${WORD_OF.get(rest)}` : "উনিশশো";
  return rest ? `দুই হাজার ${WORD_OF.get(rest)}` : "দুই হাজার";
}

const HALVES: Record<number, string> = { 1: "দেড়", 2: "আড়াই" };

/** A number as written in an answer ("৪,২০০", "২০১৪", "১.৫") in Bangla words, or null to leave it as written. */
function spokenNumber(written: string): string | null {
  const ascii = asciiDigits(written);
  if (/^\d+\.5$/.test(ascii)) {
    const whole = Number(ascii.slice(0, -2));
    return HALVES[whole] ?? `সাড়ে ${numberWords(whole)}`;
  }
  if (ascii.includes(".")) return null;
  const digits = ascii.replace(/,/g, "");
  if (digits.length > 1 && digits.startsWith("0")) return null; // a code, not an amount
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return null;
  return !ascii.includes(",") && digits.length === 4 && value >= 1900 && value <= 2099
    ? yearWords(value)
    : numberWords(value);
}

/**
 * The text sent to text-to-speech (spec 10.8, P7, D109): amounts, years and quantities in Bangla words, because
 * Parler-TTS misreads digits ("৪,২০০ টাকা" came out as "দুশো টাকা"). Numbers inside a label or a code (B-3,
 * 04465-10047, 01711-000104, 1NZ) stay as written. The screen keeps the digits.
 */
export function spokenText(text: string): string {
  return text.replace(
    /(?<![\p{L}\p{N}.,/-])[0-9০-৯]+(?:,[0-9০-৯]{2,3})*(?:\.[0-9০-৯]+)?(?![\p{N}/]|[A-Za-z]|[.,-][\p{N}A-Za-z])(-(?=\p{Script=Bengali}))?/gu,
    (match, dash: string | undefined) => {
      const number = dash ? match.slice(0, -1) : match;
      const words = spokenNumber(number);
      return words === null ? match : `${words}${dash ? " " : ""}`;
    },
  );
}
