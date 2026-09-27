import { banglaDigits } from "./text";

// Numbers in answers (spec 10.8). The grouping is the same algorithm as GearGrid's formatTaka, re-implemented here
// (no dependency between the repositories).

/** Bangladeshi grouping: the last three digits, then groups of two (12,34,567). */
function groupDigits(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${head},${digits.slice(-3)}`;
}

/** Paisa as taka: "4,500", "1,23,456.50"; with Bangla digits by default. Paisa show only when not zero. */
export function formatTaka(paisa: bigint, options: { bangla?: boolean } = {}): string {
  const sign = paisa < 0n ? "-" : "";
  const absolute = paisa < 0n ? -paisa : paisa;
  const fraction = absolute % 100n;
  let text = `${sign}${groupDigits((absolute / 100n).toString())}`;
  if (fraction !== 0n) text += `.${fraction.toString().padStart(2, "0")}`;
  return options.bangla === false ? text : banglaDigits(text);
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
