import { NUMBER_WORDS } from "./numbers";
import { asciiDigits } from "./text";

// The grounding check (spec 12.1; architecture, response builder): every number and rack label in a sentence must be
// in the tool results (after the value scale, in paisa and in taka), said by the user, a row count, or a total
// computed by code. A sentence that fails is dropped and the template answer is used instead.

/** Number words that are also ordinary words (নয় is "nine" and "is not"): never counted as numbers. */
const AMBIGUOUS_WORDS = new Set(["নয়", "নয়", "বার"]);
const RACK = /\b[A-Za-z]{1,3}-\d{1,3}\b/g;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/** A number's canonical text: no grouping commas, no trailing zero decimals (4,500.00 -> 4500). */
export function canonicalNumber(text: string): string {
  const plain = text.replaceAll(",", "");
  return plain.includes(".") ? plain.replace(/\.?0+$/, "") : plain.replace(/^0+(?=\d)/, "");
}

export class AllowedFacts {
  readonly numbers = new Set<string>();
  readonly racks = new Set<string>();

  addNumber(value: number | bigint | string | null | undefined): this {
    if (value === null || value === undefined || value === "") return this;
    const text = typeof value === "number" ? String(Math.round(value * 1000) / 1000) : String(value);
    if (/^-?\d+(\.\d+)?$/.test(text)) this.numbers.add(canonicalNumber(text.replace(/^-/, "")));
    return this;
  }

  /** Money in paisa: allowed as paisa and as taka. */
  addMoney(paisa: bigint | null | undefined): this {
    if (paisa === null || paisa === undefined) return this;
    const absolute = paisa < 0n ? -paisa : paisa;
    this.addNumber(absolute);
    const taka = absolute / 100n;
    const fraction = absolute % 100n;
    this.addNumber(fraction === 0n ? taka : `${taka}.${fraction.toString().padStart(2, "0")}`);
    return this;
  }

  addRack(label: string | null | undefined): this {
    if (label) this.racks.add(label.toUpperCase());
    return this;
  }

  /** Every number and rack label inside a text (a tool-result name such as "Alto 800" or "5W-30"). */
  addFromText(text: string | null | undefined): this {
    if (!text) return this;
    const ascii = asciiDigits(text);
    for (const match of ascii.match(RACK) ?? []) this.addRack(match);
    for (const match of ascii.match(NUMBER) ?? []) this.addNumber(canonicalNumber(match));
    return this;
  }

  /** Every value of a tool result, walked: numbers, bigints (paisa) and the numbers inside strings. */
  addResult(value: unknown): this {
    if (value === null || value === undefined) return this;
    if (typeof value === "bigint") return this.addMoney(value);
    if (typeof value === "number") return this.addNumber(value);
    if (typeof value === "string") return this.addFromText(value);
    if (Array.isArray(value)) {
      this.addNumber(value.length);
      value.forEach((item) => this.addResult(item));
      return this;
    }
    if (typeof value === "object") Object.values(value).forEach((item) => this.addResult(item));
    return this;
  }
}

export interface Found {
  numbers: string[];
  racks: string[];
}

/** Numbers (digits in either script, grouping commas, decimals, number words) and rack labels in a sentence. */
export function factsIn(sentence: string): Found {
  const ascii = asciiDigits(sentence);
  const racks = (ascii.match(RACK) ?? []).map((label) => label.toUpperCase());
  const withoutRacks = ascii.replace(RACK, " ");
  const numbers = (withoutRacks.match(NUMBER) ?? []).map((match) => canonicalNumber(match.replace(/,$/, "")));
  for (const raw of sentence.normalize("NFC").split(/[\s,;:।?!()]+/)) {
    const word = raw.replace(/(টা|টি|টো|টোই|টাই|ই)$/, "");
    if (!word || AMBIGUOUS_WORDS.has(raw) || AMBIGUOUS_WORDS.has(word)) continue;
    const value = NUMBER_WORDS.get(word) ?? NUMBER_WORDS.get(raw);
    if (value !== undefined && /[ঀ-৿]/.test(raw)) numbers.push(String(value));
  }
  return { numbers, racks };
}

/** Whether every number and rack label of the sentence is allowed. */
export function isGrounded(sentence: string, allowed: AllowedFacts): { ok: boolean; unknown: string[] } {
  const found = factsIn(sentence);
  const unknown = [
    ...found.numbers.filter((number) => !allowed.numbers.has(number)),
    ...found.racks.filter((rack) => !allowed.racks.has(rack)),
  ];
  return { ok: unknown.length === 0, unknown };
}

/** Sentences (spec 12.3): split at danda, ?, ! and line breaks (and full stops in Latin text); short pieces join
 * the next one; long pieces split at commas. */
export function splitSentences(text: string): string[] {
  const pieces = text
    .replace(/([।?!])/g, "$1\n")
    .replace(/(?<=[A-Za-z]{2})\.(?=\s)/g, ".\n")
    .split(/\n+/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  const joined: string[] = [];
  let carry = "";
  for (const piece of pieces) {
    const current = carry ? `${carry} ${piece}` : piece;
    if (current.length < 8) {
      carry = current;
      continue;
    }
    carry = "";
    joined.push(current);
  }
  if (carry) joined.push(carry);
  return joined.flatMap((sentence) => {
    if (sentence.length <= 180) return [sentence];
    const parts: string[] = [];
    let current = "";
    for (const chunk of sentence.split(/(?<=,)\s*/)) {
      if (current && current.length + chunk.length > 180) {
        parts.push(current.trim());
        current = "";
      }
      current += `${chunk} `;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  });
}
