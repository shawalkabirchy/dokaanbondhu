import numbers from "../data/bn-numbers.json";
import { banglaOf, carLabel, possessive } from "./answers";
import { money } from "./format";
import { wordNumber } from "./numbers";
import { asciiDigits, normalize } from "./text";

// The write path's words (spec 9.9, 11.10; D135): amounts as said, the yes and no of a confirmation, and the
// confirmation and result templates. Deterministic Bangla, never LLM text; a field the host did not give is left out.

const nfc = (text: string) => text.normalize("NFC").toLowerCase();

const MULTIPLIERS: ReadonlyMap<string, number> = new Map(
  (
    [
      [100, ["শো", "শ", "sho", "so", "hundred"]],
      [1_000, ["হাজার", "hajar", "hazar", "thousand"]],
      [1_00_000, ["লাখ", "লক্ষ", "lakh", "lac", "lak"]],
      [1_00_00_000, ["কোটি", "koti", "crore"]],
    ] as const
  ).flatMap(([value, words]) => words.map((word) => [nfc(word), value] as const)),
);
const HUNDRED_ENDINGS = ["শো", "শ", "sho"];
const FRACTIONS: ReadonlyMap<string, number> = new Map(
  Object.entries(numbers.fractions.whole).map(([word, value]) => [nfc(word), value]),
);

/** A token as a number: digits, a number word, a fraction word, or hundreds in one word (পাঁচশো, duisho). */
function valueOf(token: string): number | null {
  const ascii = asciiDigits(token);
  if (/^\d+(\.\d+)?$/.test(ascii)) return Number(ascii);
  const word = wordNumber(token) ?? FRACTIONS.get(nfc(token)) ?? null;
  if (word !== null) return word;
  for (const ending of HUNDRED_ENDINGS) {
    if (token.length > ending.length && nfc(token).endsWith(ending)) {
      const stem = wordNumber(token.slice(0, -ending.length));
      if (stem !== null && stem < 100) return stem * 100;
    }
  }
  return null;
}

/**
 * The first amount of money in a text, in whole taka (spec 10.6, D110): "১০ হাজার", "10 hajar", "১০,০০০ টাকা", "দশ
 * হাজার পাঁচশো", "দেড় লাখ". Null when there is none, or when it would not be whole taka.
 */
export function parseAmount(text: string): number | null {
  // Grouping commas join their digits before the text is split: ১০,০০০ and 1,00,000 are one number each.
  const joined = asciiDigits(text).replace(/(\d)[,،](?=\d{2,3}(\D|$))/g, "$1");
  const tokens = normalize(joined).tokens;
  const start = tokens.findIndex((token) => valueOf(token) !== null);
  if (start < 0) return null;
  let total = 0;
  let current: number | null = null;
  for (const token of tokens.slice(start)) {
    const value = valueOf(token);
    const multiplier = MULTIPLIERS.get(nfc(token));
    if (value !== null && multiplier === undefined) {
      if (current !== null) total += current;
      current = value;
    } else if (multiplier !== undefined) {
      current = (current ?? 1) * multiplier;
      if (multiplier >= 1_000) {
        total += current;
        current = null;
      }
    } else {
      break; // "টাকা" or any other word ends the amount
    }
  }
  total += current ?? 0;
  const rounded = Math.round(total * 1000) / 1000;
  return rounded > 0 && Number.isInteger(rounded) ? rounded : null;
}

// Yes and no (spec 9.9): an utterance of at most three words made only of these, after normalization.
const YES = [
  "হ্যাঁ",
  "হা",
  "জি",
  "জ্বি",
  "ঠিক আছে",
  "ঠিক",
  "ওকে",
  "ha",
  "haa",
  "hya",
  "ji",
  "jee",
  "thik ache",
  "thik",
  "ok",
  "okay",
  "oke",
  "yes",
];
const NO = ["না", "না না", "বাতিল", "থাক", "na", "naa", "na na", "batil", "thak", "no", "cancel"];
const phrases = (words: string[]) => words.map((word) => normalize(word).tokens);

function madeOf(tokens: string[], list: string[][]): boolean {
  if (!tokens.length) return true;
  return list.some(
    (phrase) =>
      phrase.length <= tokens.length &&
      phrase.every((token, index) => tokens[index] === token) &&
      madeOf(tokens.slice(phrase.length), list),
  );
}

/** "yes", "no", or null for anything else (a correction attempt): হ্যাঁ, ha thik ache; না, batil. */
export function decisionOf(text: string): "yes" | "no" | null {
  const tokens = normalize(text).tokens;
  if (!tokens.length || tokens.length > 3) return null;
  if (madeOf(tokens, phrases(YES))) return "yes";
  if (madeOf(tokens, phrases(NO))) return "no";
  return null;
}

/** Template kinds of spec 11.10. */
export type ActionTemplate =
  "sale" | "payment" | "stock_in" | "return" | "price_update" | "add_fitment" | "generic";

/** One part line of an action, as understood (display text, never IDs). */
export interface ActionLine {
  vehicle?: string; // glossary value
  year?: number | null;
  position?: string | null; // glossary value
  part?: string; // display name
  quality?: string | null; // glossary value
  quantity?: string; // "২ সেট"
  unit?: string; // the unit word for "প্রতি সেট"
  unitCost?: bigint | null;
}

export interface ActionFields {
  customer?: string | null;
  supplier?: string | null;
  lines?: ActionLine[];
  total?: bigint | null;
  amount?: bigint | null;
  /** বাকিতে, নগদ, or a method with its amount (paymentText). */
  payment?: string | null;
  date?: string | null;
  refund?: string | null;
  tier?: "retail" | "garage" | "wholesale";
  oldPrice?: bigint | null;
  newPrice?: bigint | null;
  years?: string | null;
  /** generic: the action's label and its fields. */
  label?: string;
  pairs?: { label: string; value: string }[];
}

const METHOD_BN: Record<string, string> = {
  cash: "নগদ",
  bkash: "বিকাশ",
  nagad: "নগদ অ্যাকাউন্ট",
  rocket: "রকেট",
  bank: "ব্যাংক",
  cheque: "চেক",
  card: "কার্ড",
};

/** A payment method in Bangla, or the host's own word. */
export function methodText(method: string): string {
  return METHOD_BN[method.toLowerCase()] ?? method;
}

/** [payment] of a sale: বাকিতে with no payment, নগদ for cash of the whole total, else each method with its amount. */
export function paymentText(payments: { method: string; amount: bigint }[], total: bigint | null): string {
  if (!payments.length) return "বাকিতে";
  if (payments.length === 1 && payments[0]!.method.toLowerCase() === "cash" && payments[0]!.amount === total)
    return "নগদ";
  return payments.map((payment) => `${methodText(payment.method)} ${money(payment.amount)}`).join(", ");
}

function lineText(line: ActionLine): string {
  const car = line.vehicle ? carLabel(line.vehicle, line.year ?? null) : null;
  const part = [line.position ? banglaOf("position", line.position) : null, line.part]
    .filter(Boolean)
    .join(" ");
  return [car, part || null, line.quality ? banglaOf("quality", line.quality) : null, line.quantity]
    .filter(Boolean)
    .join(", ");
}

const TIER_BN = { retail: "খুচরা", garage: "গ্যারেজ", wholesale: "পাইকারি" } as const;

/** The confirmation of spec 11.10, ending in its question. */
export function confirmationText(kind: ActionTemplate, fields: ActionFields): string {
  const lines = (fields.lines ?? []).map(lineText).filter(Boolean);
  const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(", ");
  switch (kind) {
    case "sale": {
      const body = join(lines.join("; "), fields.total != null && money(fields.total), fields.payment);
      return `${fields.customer ? `${fields.customer} — ` : ""}${body}। ঠিক আছে?`;
    }
    case "payment":
      return `${fields.customer ?? ""} থেকে ${fields.amount != null ? money(fields.amount) : ""} জমা${fields.payment ? `, ${fields.payment}` : ""}। ঠিক আছে?`
        .replace(/\s+/g, " ")
        .trim();
    case "stock_in": {
      const line = fields.lines?.[0];
      const each =
        line?.unitCost != null && fields.lines?.length === 1
          ? `প্রতি ${line.unit ?? "টা"} ${money(line.unitCost)}`
          : null;
      const body = join(
        fields.lines?.map((item) => join(item.part, item.quantity)).join("; "),
        each,
        fields.total != null && `মোট ${money(fields.total)}`,
      );
      return `${fields.supplier ? `${fields.supplier} থেকে ` : ""}${body}। ঠিক আছে?`;
    }
    case "return": {
      const body = join(
        [fields.date, lines.join("; ")].filter(Boolean).join(" "),
        fields.total != null && `${money(fields.total)} ফেরত`,
        fields.refund,
      );
      return `${fields.customer ? `${fields.customer} — ` : ""}${body}। ঠিক আছে?`;
    }
    case "price_update": {
      const part = fields.lines?.[0]?.part ?? "";
      const tier = TIER_BN[fields.tier ?? "retail"];
      const from = fields.oldPrice != null ? `${money(fields.oldPrice)} থেকে ` : "";
      return `${possessive(part)} ${tier} দাম ${from}${fields.newPrice != null ? money(fields.newPrice) : ""}। ঠিক আছে?`;
    }
    case "add_fitment": {
      const line = fields.lines?.[0];
      const car = line?.vehicle ? banglaOf("vehicle_model", line.vehicle) : "";
      return `${line?.part ?? ""} — ${car}${fields.years ? ` ${fields.years}` : ""}-এ লাগে। যোগ করব?`;
    }
    default: {
      const pairs = (fields.pairs ?? []).map((pair) => `${pair.label}: ${pair.value}`);
      return `${[fields.label, ...pairs].filter(Boolean).join(", ")}। ঠিক আছে?`;
    }
  }
}

export interface ResultFields {
  customer?: string | null;
  supplier?: string | null;
  /** The customer's due after the action, from the host's answer. */
  due?: bigint | null;
  payable?: bigint | null;
  /** A sale's part and its rack. */
  part?: string | null;
  rack?: string | null;
  /** failed: the host's Bangla reason, or the template for its error. */
  reason?: string | null;
}

export type ResultStatus = "done" | "failed" | "review" | "cancelled" | "expired" | "undone";

function balanceSentence(kind: ActionTemplate, fields: ResultFields): string | null {
  if ((kind === "sale" || kind === "return") && fields.customer && fields.due != null)
    return `${possessive(fields.customer)} মোট বাকি এখন ${money(fields.due)}।`;
  if (kind === "payment" && fields.customer && fields.due != null)
    return `${possessive(fields.customer)} বাকি এখন ${money(fields.due)}।`;
  if (kind === "stock_in" && fields.supplier && fields.payable != null)
    return `${possessive(fields.supplier)} পাওনা এখন ${money(fields.payable)}।`;
  return null;
}

/** The reply after the host answers (spec 11.10): a template, never LLM text; a sentence without its value is left out. */
export function resultText(status: ResultStatus, kind: ActionTemplate, fields: ResultFields = {}): string {
  switch (status) {
    case "done": {
      const first = kind === "payment" ? "জমা হয়েছে।" : "হয়ে গেছে।";
      const rack =
        kind === "sale" && fields.part && fields.rack ? `${fields.part} ${fields.rack} তাকে আছে।` : null;
      return [first, balanceSentence(kind, fields), rack].filter(Boolean).join(" ");
    }
    case "failed":
      return ["কাজটা হয়নি।", fields.reason].filter(Boolean).join(" ");
    case "review":
      return "সেভ হয়েছে কিনা নিশ্চিত না। ইতিহাসে দেখে নিন।";
    case "undone":
      return ["আগের কাজটা ফিরিয়ে নেওয়া হয়েছে।", balanceSentence(kind, fields)].filter(Boolean).join(" ");
    default:
      return "বাতিল করা হয়েছে, কিছু সেভ হয়নি।";
  }
}

/** The reason of a host refusal without a Bangla message, by its HTTP status (spec 11.9 step 5). */
export function refusalText(status: number): string {
  if (status === 401 || status === 403) return "অ্যাপ অনুমতি দেয়নি।";
  if (status === 404) return "অ্যাপে জিনিসটা পাওয়া যায়নি।";
  if (status === 409) return "অ্যাপের হিসাবের সাথে মেলেনি।";
  if (status === 422 || status === 400) return "অ্যাপ তথ্যগুলো নেয়নি।";
  return "অ্যাপে সমস্যা হয়েছে।";
}
