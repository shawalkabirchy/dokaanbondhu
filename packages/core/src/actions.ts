import numbers from "../data/bn-numbers.json";
import { banglaOf, carLabel, possessive } from "./answers";
import { money } from "./format";
import { rackSaid } from "./names";
import { MISHEARD_THOUSAND, wordNumber } from "./numbers";
import { parseQuantity } from "./quantity";
import { asciiDigits, banglaDigits, normalize } from "./text";

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
  // A thousand or a lakh said first is one of them: "হাজার পাঁচশ" is 1,500 (D178).
  const start = tokens.findIndex(
    (token) => valueOf(token) !== null || (MULTIPLIERS.get(nfc(token)) ?? 0) >= 1_000,
  );
  if (start < 0) return null;
  let total = 0;
  let current: number | null = null;
  for (const token of tokens.slice(start)) {
    const value = valueOf(token);
    // হাজত for হাজার counts only right after a number (D152).
    const multiplier: number | undefined =
      MULTIPLIERS.get(nfc(token)) ??
      (current !== null && MISHEARD_THOUSAND.has(nfc(token)) ? 1_000 : undefined);
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
  | "sale"
  | "payment"
  | "stock_in"
  | "return"
  | "price_update"
  | "rack_update"
  | "add_fitment"
  | "add_customer"
  | "add_supplier"
  | "generic";

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
  /** A sale's price the user set for one (D176), said after the quantity. */
  unitPrice?: bigint | null;
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
  /** The price changed: the only two kinds the owner sees (D145). */
  tier?: "retail" | "paikari";
  oldPrice?: bigint | null;
  newPrice?: bigint | null;
  years?: string | null;
  /** A rack change (D195): the rack the part goes on, and the one it is on now. */
  rack?: string | null;
  oldRack?: string | null;
  /** A new customer or supplier (D173): the name as said, a customer's price kind, the phone (11 digits). */
  name?: string | null;
  kind?: "retail" | "paikari" | null;
  phone?: string | null;
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
  return [
    car,
    part || null,
    line.quality ? banglaOf("quality", line.quality) : null,
    line.quantity,
    line.unitPrice != null ? `প্রতি ${line.unit ?? "টা"} ${money(line.unitPrice)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

const TIER_BN = { retail: "খুচরা", paikari: "পাইকারি" } as const;

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
    case "rack_update": {
      const part = fields.lines?.[0]?.part ?? "";
      return `${part} রাখা হবে ${fields.rack ?? ""}-এ${fields.oldRack ? ` (এখন ${fields.oldRack})` : ""}। ঠিক আছে?`;
    }
    case "add_fitment": {
      const line = fields.lines?.[0];
      const car = line?.vehicle ? banglaOf("vehicle_model", line.vehicle) : "";
      return `${line?.part ?? ""} — ${car}${fields.years ? ` ${fields.years}` : ""}-এ লাগে। যোগ করব?`;
    }
    case "add_customer":
    case "add_supplier": {
      const said = [
        fields.name,
        fields.kind ? TIER_BN[fields.kind] : null,
        fields.phone ? phoneText(fields.phone) : null,
      ];
      return `নতুন ${kind === "add_customer" ? "কাস্টমার" : "সাপ্লায়ার"}: ${said.filter(Boolean).join(", ")}। যোগ করব?`;
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
  /** A new customer's or supplier's name (D173). */
  name?: string | null;
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
      const added = (kind === "add_customer" || kind === "add_supplier") && fields.name;
      const first = added ? `${fields.name} যোগ হয়েছে।` : kind === "payment" ? "জমা হয়েছে।" : "হয়ে গেছে।";
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

// Words that ask for a write (D140): a sale, a received payment or a purchase said as an instruction. A sentence with
// a question word ("দাম", "কত", "আছে?") asks something and is never taken as one. Matched on normalized words.
const WRITE_CUES: Record<"sale" | "payment" | "stock_in" | "return", string[]> = {
  // A return (D169): its word alone, looked for before a sale's (ফেরত দাও holds দাও).
  return: ["ফেরত", "ফেরৎ", "রিটার্ন", "ferot", "ferat", "feret", "return", "ritarn"],
  sale: [
    "দাও",
    "দিয়ে দাও",
    "দিন",
    "বিক্রি",
    "বেচো",
    "বেচলাম",
    "dao",
    "diye dao",
    "din",
    "bikri",
    "becho",
    "sell",
    // The polite forms, as staff say them (D186): still a sale only with a customer or a payment word.
    "দেন",
    "লিখে দেন",
    "লিখেন",
    "লিখুন",
    "den",
    "likhe den",
    "likhen",
  ],
  payment: [
    "জমা নাও",
    "জমা নিলাম",
    "জমা দিল",
    "জমা দিয়েছে",
    "জমা",
    "joma nao",
    "joma nilam",
    "joma dilo",
    "joma",
  ],
  stock_in: ["কিনলাম", "কিনেছি", "স্টকে তোলো", "স্টক ইন", "kinlam", "kinechi", "stock e tolo", "stock in"],
};

/** Goods arriving ("…থেকে দশটা এলো", "theke aslo"): a purchase only with its supplier named (D186). */
const ARRIVED = ["এসেছে", "আসছে", "আসলো", "এলো", "eseche", "asche", "aslo", "elo", "ashche", "ashlo"];
/** Never a part's detail: "aslo" (it came) is not আসল (genuine), D187. */
const ARRIVED_WORDS = new Set(ARRIVED.flatMap((word) => normalize(word).tokens));
/** Asking for a customer's number, phone or address: "…er number ta den" is a question, never a sale (D187). */
const INFO_WORDS = new Set(
  [
    "নম্বর",
    "নাম্বার",
    "নম্বরটা",
    "ফোন",
    "ঠিকানা",
    "number",
    "nombor",
    "nambar",
    "phone",
    "fon",
    "address",
    "thikana",
  ].flatMap((word) => normalize(word).tokens),
);
/**
 * Words for on credit, said with a sale or a purchase (spec 9.6: বাকিতে is no payment), with how speech-to-text wrote
 * বাকিতে in the owner's tests (D152): only here, inside a sale or purchase, is বাতিতে ("in the lamp") taken for it.
 */
const CREDIT_WORDS = new Set(
  [
    "বাকিতে",
    "বাকি",
    "বাকিত",
    "উধার",
    "উধারে",
    "বাঁকিতে",
    "বাতিতে",
    "বাঁচিতে",
    "bakite",
    "baki",
    "bakit",
    "baakite",
    "udhar",
    "udhare",
    "due",
    "credit",
  ].map((word) => normalize(word).tokens.join(" ")),
);

/** Whether a sale or purchase is said on credit. */
export function saysCredit(text: string): boolean {
  return normalize(text).tokens.some((token) => CREDIT_WORDS.has(token));
}

const PAYMENT_WORDS = [
  "বাকিতে",
  "বাঁকিতে",
  "বাতিতে",
  "বাঁচিতে",
  "নগদে",
  "ক্যাশে",
  "বিকাশে",
  "bakite",
  "nogode",
  "baakite",
  "cash e",
  "bikashe",
  "bkash e",
];
/** A price change (D171): দাম or price, the new amount as money, and a word that sets it; never with বিক্রি. */
const PRICE_WORDS = new Set(
  ["দাম", "dam", "daam", "price", "রেট", "rate"].map((word) => normalize(word).tokens.join(" ")),
);
const SET_PRICE = [
  "করো",
  "করে দাও",
  "করে দিন",
  "করে দেন",
  "করে দিবেন",
  "করে দেবেন",
  "করেন",
  "করুন",
  "রাখো",
  "রাখেন",
  "koro",
  "kore dao",
  "kore din",
  "kore den",
  "kore diben",
  "kore deben",
  "koren",
  "korun",
  "rakho",
  "rakhen",
  "set koro",
];
const SELLING = ["বিক্রি", "বেচো", "bikri", "becho", "sell"];

/**
 * A rack change (D195): a rack label said ("বি-৩", "B-3", "c dui") with a word that puts the part there ("রাখো", "rakho",
 * "সরাও"), or with a rack word and one that sets it ("র‍্যাক বি-৩ করো", "rack D-14 koro").
 */
const PUT_ON_RACK = new Set(
  [
    "রাখো",
    "রাখ",
    "রাখেন",
    "রাখুন",
    "রাখবা",
    "রেখে",
    "সরাও",
    "সরিয়ে",
    "rakho",
    "rakh",
    "rakhen",
    "rakhun",
    "rakhba",
    "rekhe",
    "sorao",
    "shorao",
    "soriye",
    "shoriye",
  ].map((word) => normalize(word).tokens.join(" ")),
);
const RACK_NAMES = new Set(
  ["র‍্যাক", "র‍্যাকে", "র‍্যাকের", "তাক", "তাকে", "তাকের", "rack", "racke", "tak", "take", "taker"].map(
    (word) => normalize(word).tokens.join(" "),
  ),
);
const SET_RACK = new Set(
  ["করো", "করেন", "করুন", "বদলাও", "বদলে", "koro", "koren", "korun", "bodlao", "bodle", "change"].map(
    (word) => normalize(word).tokens.join(" "),
  ),
);
/** Words that change a part's rack without naming the new one: "র‍্যাক বদলাতে হবে", "rack bodlate hobe". */
const CHANGE_RACK = new Set(
  [
    "বদলাতে",
    "বদলানো",
    "বদলাও",
    "বদলে",
    "পাল্টাও",
    "পাল্টাতে",
    "bodlate",
    "bodlao",
    "bodle",
    "paltao",
    "paltate",
    "change",
  ].map((word) => normalize(word).tokens.join(" ")),
);
function saysRack(text: string, tokens: string[]): boolean {
  const rackWord = tokens.some((token) => RACK_NAMES.has(token));
  // The rack left out: the change still starts, and its question asks which rack (D202).
  if (!rackSaid(text)) return rackWord && tokens.some((token) => CHANGE_RACK.has(token));
  if (tokens.some((token) => PUT_ON_RACK.has(token))) return true;
  return rackWord && tokens.some((token) => SET_RACK.has(token));
}

/**
 * A fitment said (D172): লাগে with "also" on the car ("প্রিমিওতেও লাগে", "premio teo lage") or with a word that records
 * it ("লাগে, লিখে রাখো", "lage jog koro"). লাগবে and কিনা ask, so they are never one.
 */
const FITS = new Set(["লাগে", "lage", "lagey"].map((word) => normalize(word).tokens.join(" ")));
const FIT_ASKS = new Set(["লাগবে", "lagbe", "কিনা", "kina"].map((word) => normalize(word).tokens.join(" ")));
const RECORD_FIT = ["লিখে রাখো", "লিখে রাখেন", "যোগ করো", "যোগ করেন", "likhe rakho", "jog koro", "add koro"];
function saysFits(tokens: string[]): boolean {
  const at = tokens.findIndex((token) => FITS.has(token));
  if (at < 0 || tokens.some((token) => FIT_ASKS.has(token))) return false;
  if (RECORD_FIT.some((phrase) => said(tokens, phrase))) return true;
  // "also" on the car: প্রিমিওতেও, ফিল্ডারেও, প্রিমিওয়েও (a vowel sign ে, then ও), প্রিমিওএও; premioteo, premio-teo,
  // "premio te o", "premio o".
  const before = tokens.slice(Math.max(0, at - 3), at).join(" ");
  return /(ে|এ)ও$|(^|\s)ও$|(te|e)-?o$|\s(te|e)\so$|(^|\s)o$/u.test(before);
}

const ALSO_BN = /(তেও|য়েও|এও|েও)$/u;
const ALSO_LATIN = new Set(["teo", "eo", "o", "tew", "eow"]);

/**
 * The words of the car a fitment adds: the one said with "also" before লাগে ("প্রিমিওতেও", "ফিল্ডারেও", "premio teo",
 * "fielder eo", "premioteo"), with the word before it for a two-word car; null when none is said (D172, D174).
 */
export function alsoCarWords(text: string): string | null {
  const tokens = normalize(text).tokens;
  const at = tokens.findIndex((token) => FITS.has(token));
  if (at < 1) return null;
  const before = tokens.slice(Math.max(0, at - 4), at);
  const withWordBefore = (index: number, car: string) =>
    [index > 0 ? before[index - 1] : null, car].filter(Boolean).join(" ");
  for (let index = before.length - 1; index >= 0; index--) {
    const token = before[index]!;
    if (ALSO_BN.test(token) && token.replace(ALSO_BN, ""))
      return withWordBefore(index, token.replace(ALSO_BN, ""));
    // "প্রিমিও ২০০৯-তেও": the ending split from a year
    if (ALSO_BN.test(token) && index > 0) return withWordBefore(index - 1, before[index - 1]!);
    if (token === "ও" && index > 0)
      return withWordBefore(index - 1, before[index - 1]!.replace(/(তে|য়ে|এ|ে)$/u, ""));
    if (ALSO_LATIN.has(token) && index > 0) {
      const car = before[index - 1]!;
      // "premio te o": the marker split in two
      if ((car === "te" || car === "e") && index > 1) return withWordBefore(index - 2, before[index - 2]!);
      return withWordBefore(index - 1, car);
    }
    const glued = /^(.+?)(teo|eo)$/.exec(token);
    if (glued && /[a-z]/.test(token)) return withWordBefore(index, glued[1]!);
  }
  return null;
}

/** The words that ask for a write, and how it is paid. */
const WRITE_WORDS = new Set(
  [...Object.values(WRITE_CUES).flat(), ...PAYMENT_WORDS].flatMap((phrase) => normalize(phrase).tokens),
);

/**
 * Whether a word asks for a write or says how it is paid: such a word is never a part's detail, so "ফেরত নাও"
 * (return it) is not heard as পুরাতন (used), nor "ferot nao" as puraton (D169).
 */
export function isWriteWord(token: string): boolean {
  return (
    WRITE_WORDS.has(token) || CREDIT_WORDS.has(token) || GIVE_WORDS.has(token) || ARRIVED_WORDS.has(token)
  );
}

/**
 * The polite ways to say give or write it down, which end a request but ask for nothing by themselves ("দামটা বলে
 * দেন" is no sale), so they are no write cue; still never a part's detail: "লিখে দেন" is not ডান (right, D186).
 */
const GIVE_WORDS = new Set(
  [
    "দেন",
    "দিন",
    "দাও",
    "দিবেন",
    "দেবেন",
    "দিয়েন",
    "লিখে",
    "লিখেন",
    "লেখেন",
    "লিখুন",
    "den",
    "din",
    "dao",
    "diben",
    "deben",
    "diyen",
    "likhe",
    "likhen",
    "lekhen",
  ].flatMap((word) => normalize(word).tokens),
);

const QUESTION_WORDS = new Set(
  [
    "কত",
    "দাম",
    "আছে",
    "কি",
    "কী",
    "কোন",
    "কয়",
    "কেমন",
    "দেখাও",
    "বলো",
    "koto",
    "dam",
    "ache",
    "ki",
    "kon",
    "koy",
    "dekhao",
    "bolo",
    // Asking to be told or shown, politely ("দামটা বলে দেন", "dam ta bole den"): a question, never a write (D186).
    "বলে",
    "বলেন",
    "বলুন",
    "জানান",
    "দেখান",
    "bole",
    "bolen",
    "bolun",
    "janan",
    "dekhan",
  ].map((word) => normalize(word).tokens.join(" ")),
);
const said = (tokens: string[], phrase: string) =>
  ` ${tokens.join(" ")} `.includes(` ${normalize(phrase).tokens.join(" ")} `);

/**
 * The kind of write a sentence asks for, or null: a sale ("দাও", "dao" with a payment word or a named customer), a
 * received payment ("জমা নাও", "joma nao"), a purchase ("কিনলাম", "kinlam"), a return ("ফেরত", "ferot"), a
 * price change ("দাম ৮৫০০ করো", "dam 8500 koro") or a rack change ("বি-৩ এ রাখো", "B-3 e rakho"). A question is never one.
 */
export function writeCueOf(
  text: string,
  options: { partyNamed: boolean; supplierNamed?: boolean },
):
  | "sale"
  | "payment"
  | "stock_in"
  | "return"
  | "price_update"
  | "rack_update"
  | "add_fitment"
  | "add_customer"
  | "add_supplier"
  | null {
  const tokens = normalize(text).tokens;
  if (!tokens.length || text.trim().endsWith("?")) return null;
  // A price change names the price it sets (D171); every other write is said without a question word.
  const asks = tokens.some((token) => QUESTION_WORDS.has(token) && !PRICE_WORDS.has(token));
  if (asks) return null;
  if (WRITE_CUES.return.some((phrase) => said(tokens, phrase))) return "return";
  if (WRITE_CUES.payment.some((phrase) => said(tokens, phrase))) return "payment";
  if (WRITE_CUES.stock_in.some((phrase) => said(tokens, phrase))) return "stock_in";
  if (options.supplierNamed && ARRIVED.some((phrase) => said(tokens, phrase))) return "stock_in";
  if (saysRack(text, tokens)) return "rack_update";
  if (tokens.some((token) => PRICE_WORDS.has(token))) {
    const sets = SET_PRICE.some((phrase) => said(tokens, phrase));
    const selling = SELLING.some((phrase) => said(tokens, phrase));
    return sets && !selling && saidMoney(text).size > 0 ? "price_update" : null;
  }
  if (saysFits(tokens)) return "add_fitment";
  const party = newPartyOf(tokens);
  if (party && !PAYMENT_WORDS.some((phrase) => said(tokens, phrase))) return party;
  if (
    WRITE_CUES.sale.some((phrase) => said(tokens, phrase)) &&
    !tokens.some((token) => INFO_WORDS.has(token)) &&
    (options.partyNamed || PAYMENT_WORDS.some((phrase) => said(tokens, phrase)))
  )
    return "sale";
  return null;
}

const DAMAGED_WORDS = new Set(
  [
    "নষ্ট",
    "খারাপ",
    "ভাঙা",
    "ভাঙ্গা",
    "ড্যামেজ",
    "nosto",
    "noshto",
    "nshto",
    "kharap",
    "kharaf",
    "vanga",
    "bhanga",
    "damaged",
    "damage",
  ].map((word) => normalize(word).tokens.join(" ")),
);

/** Whether a returned part is said to be damaged, so it does not go back to stock (D169). */
export function saysDamaged(text: string): boolean {
  return normalize(text).tokens.some((token) => DAMAGED_WORDS.has(token));
}

const DAYS_AGO: ReadonlyMap<string, number> = new Map(
  (
    [
      [0, ["আজ", "আজকে", "আজকের", "aj", "ajke", "ajker", "today"]],
      [
        1,
        [
          "গতকাল",
          "গতকালকে",
          "গতকালের",
          "কাল",
          "কালকে",
          "কালকের",
          "gotokal",
          "gotokalke",
          "gotokaler",
          "kal",
          "kalke",
          "kalker",
          "yesterday",
        ],
      ],
      [2, ["পরশু", "পরশুর", "porshu", "porshur", "poroshu", "porsu"]],
    ] as const
  ).flatMap(([days, words]) => words.map((word) => [normalize(word).tokens.join(" "), days] as const)),
);
const DAY_WORDS = new Set(["দিন", "din", "day", "days"].map((word) => normalize(word).tokens.join(" ")));
const AGO_WORDS = new Set(["আগে", "age", "ago"].map((word) => normalize(word).tokens.join(" ")));

/**
 * When a sale was, as said with a return (D169): how many days ago, from আজ, গতকাল, পরশু or "[n] দিন আগে"
 * ("aj", "gotokal", "3 din age"); null when nothing says it.
 */
export function daysAgoSaid(text: string): number | null {
  const tokens = normalize(asciiDigits(text)).tokens;
  for (let index = 0; index < tokens.length; index++) {
    if (DAY_WORDS.has(tokens[index + 1] ?? "") && AGO_WORDS.has(tokens[index + 2] ?? "")) {
      const count = parseAmount(tokens[index]!);
      if (count !== null && count < 31) return count;
    }
  }
  for (const token of tokens) {
    const days = DAYS_AGO.get(token);
    if (days !== undefined) return days;
  }
  return null;
}

/** A walk-in buyer, as the customer question of a return takes it (its button, or the words, D169). */
export const WALK_IN = "walk-in";
const WALK_IN_WORDS = [
  "নাম ছাড়া",
  "নাম ছাড়াই",
  "ওয়াক ইন",
  "ওয়াকইন",
  "walk in",
  "walkin",
  "nam chara",
  "nam chhara",
];

/** Whether an answer says the buyer was a walk-in, with no name. */
export function saysWalkIn(text: string): boolean {
  const tokens = normalize(text).tokens;
  return WALK_IN_WORDS.some((phrase) => said(tokens, phrase));
}

// A new customer or supplier (D173): নতুন with the party's word and an add word ("নতুন কাস্টমার যোগ করো", "notun
// supplier add koro"). গ্যারেজ is a customer word here, never a price kind, since it is often part of a name.
const NEW_WORDS = ["নতুন", "নুতন", "notun", "nutun", "new"];
const PARTY_WORDS = {
  add_customer: [
    "কাস্টমার",
    "কাস্টোমার",
    "খদ্দের",
    "ক্রেতা",
    "গ্যারেজ",
    "customer",
    "kastomar",
    "costomer",
    "garage",
  ],
  add_supplier: ["সাপ্লায়ার", "সাপ্লাইয়ার", "মহাজন", "supplier", "saplayar", "suplier", "mohajon"],
} as const;
const ADD_WORDS = ["যোগ", "অ্যাড", "খোলো", "খুলো", "খোলেন", "add", "jog", "khulo", "kholo"];

function newPartyOf(tokens: string[]): "add_customer" | "add_supplier" | null {
  if (!NEW_WORDS.some((word) => said(tokens, word)) || !ADD_WORDS.some((word) => said(tokens, word)))
    return null;
  if (PARTY_WORDS.add_supplier.some((word) => said(tokens, word))) return "add_supplier";
  if (PARTY_WORDS.add_customer.some((word) => said(tokens, word))) return "add_customer";
  return null;
}

/** The value of the button that adds a name the app does not have (D173). */
export const NEW_PARTY = "__new__";

/** Whether an answer chooses to add the name as a new one: the button's words, or নতুন alone (D173). */
export function saysNewParty(text: string): boolean {
  const tokens = normalize(text).tokens;
  return tokens.length <= 5 && NEW_WORDS.some((word) => said(tokens, word));
}

const RETAIL_KIND = [
  "খুচরা",
  "খুচরো",
  "রিটেইল",
  "সাধারণ",
  "khuchra",
  "khucra",
  "khuchro",
  "retail",
  "normal",
];
const PAIKARI_KIND = [
  "পাইকারি",
  "পাইকার",
  "গ্যারেজ",
  "মিস্ত্রি",
  "ডিলার",
  "হোলসেল",
  "paikari",
  "paikar",
  "garage",
  "mistri",
  "dealer",
  "wholesale",
  "mechanic",
];

/**
 * A new customer's price kind as said (D173): খুচরা or পাইকারি, with the app's garage, dealer or wholesale words as
 * paikari (D145). `inRequest` leaves out গ্যারেজ and garage, which a request says as part of a name.
 */
export function customerKindOf(
  text: string,
  options: { inRequest?: boolean } = {},
): "retail" | "paikari" | null {
  const tokens = normalize(text).tokens;
  const paikari = PAIKARI_KIND.filter((word) => !options.inRequest || !["গ্যারেজ", "garage"].includes(word));
  if (paikari.some((word) => said(tokens, word))) return "paikari";
  if (RETAIL_KIND.some((word) => said(tokens, word))) return "retail";
  return null;
}

const NO_PHONE = ["নেই", "নাই", "না", "জানি না", "পরে", "nei", "nai", "na", "no", "none", "jani na", "pore"];

/**
 * A phone number as said or typed (D173): 11 digits from 01, in Bangla or Latin digits, with spaces, dashes or +88;
 * "none" for নেই, nei; null for anything else.
 */
export function phoneOf(text: string): string | "none" | null {
  const ascii = asciiDigits(text);
  let digits = ascii.replace(/[^\d+]/g, "").replace(/^\+/, "");
  // Said digit by digit, as speech-to-text may write it: "শূন্য এক সাত…", "zero one seven double one…".
  if (digits.length < 11) digits = spokenDigits(text) || digits;
  if (!digits) {
    const tokens = normalize(text).tokens;
    return tokens.length <= 3 && NO_PHONE.some((word) => said(tokens, word)) ? "none" : null;
  }
  if (digits.length === 13 && digits.startsWith("880")) digits = digits.slice(2);
  return /^01[3-9]\d{8}$/.test(digits) ? digits : null;
}

const DOUBLE = new Set(["ডাবল", "double", "dabol"]);

/** A number said as words, digit by digit or in pairs ("সতেরো"), with ডাবল for a digit twice; "" when none is. */
function spokenDigits(text: string): string {
  let out = "";
  let times = 1;
  for (const token of normalize(text).tokens) {
    if (DOUBLE.has(token)) {
      times = 2;
      continue;
    }
    const ascii = asciiDigits(token);
    const word = /^\d+$/.test(ascii) ? null : wordNumber(token);
    const value = /^\d+$/.test(ascii) ? ascii : word !== null && word < 100 ? String(word) : null;
    if (value !== null) out += value.repeat(times);
    times = 1;
  }
  return out;
}

/** A phone of 11 digits as the sheet shows it: ০১৭১১-২২৩৩৪৪. */
export function phoneText(phone: string): string {
  return banglaDigits(phone.length === 11 ? `${phone.slice(0, 5)}-${phone.slice(5)}` : phone);
}

/** What staff are told when they ask for a write only the owner may make, and nothing changes (D171). */
export function ownerOnlyText(kind: ActionTemplate): string {
  return kind === "price_update"
    ? "দাম বদলাতে পারেন শুধু দোকানের মালিক।"
    : "এটা শুধু দোকানের মালিক করতে পারেন।";
}

/** How a return's money goes back (spec 11.10 [refund]): off the due, in cash, or both with their amounts. */
export function refundText(due: bigint, cash: bigint): string {
  if (cash === 0n) return "বাকি থেকে কাটা হবে";
  if (due === 0n) return "নগদ ফেরত";
  return `বাকি থেকে ${money(due)}, নগদ ${money(cash)}`;
}

/** A word of a said number: digits, a number word, a multiplier, or a misheard thousand (তিন হাউজার, D178). */
const inNumberRun = (token: string) =>
  valueOf(token) !== null || MULTIPLIERS.has(nfc(token)) || MISHEARD_THOUSAND.has(nfc(token));

/** Words that make the number before them money, and words that make the number after them a price (D157). */
// টাকায়, takay: "at a price of" (D177), money as টাকা is.
const MONEY_AFTER = new Set(
  ["টাকা", "taka", "tk", "৳", "টাকায়", "টাকাই", "টাকাতে", "takay", "takai", "takaye"].map((word) =>
    normalize(word).tokens.join(" "),
  ),
);
const PRICE_BEFORE = new Set(
  ["প্রতি", "proti", "per", "দাম", "dam"].map((word) => normalize(word).tokens.join(" ")),
);

/**
 * The amounts a text says as money (D157): the number before টাকা or taka, or the price after প্রতি, per or দাম. A
 * quantity is never one, so "পাঁচ সেন্ট কিনলাম" (সেট heard as সেন্ট) gives no unit cost of 5 taka.
 */
export function saidMoney(text: string): Set<number> {
  const tokens = normalize(asciiDigits(text).replace(/(\d)[,،](?=\d{2,3}(\D|$))/g, "$1")).tokens;
  const money = new Set<number>();
  tokens.forEach((token, index) => {
    if (MONEY_AFTER.has(token)) {
      // Only the unbroken run of number words right before টাকা: "পাঁচ সেট … ১২০০ টাকা" is 1,200, never 5.
      let start = index;
      while (start > 0 && inNumberRun(tokens[start - 1]!)) start--;
      const amount = start < index ? parseAmount(tokens.slice(start, index).join(" ")) : null;
      if (amount !== null) money.add(amount);
    }
    if (PRICE_BEFORE.has(token)) {
      const amount = parseAmount(tokens.slice(index + 1, index + 8).join(" "));
      if (amount !== null) money.add(amount);
    }
  });
  return money;
}

const word = (text: string) => normalize(text).tokens.join(" ");
/** The price of what the line says: "৩০০০ টাকায়", "3000 takay", "৩০০০ টাকা দামে" (D176). */
const LINE_PRICE = new Set(["টাকায়", "টাকাই", "টাকাতে", "takay", "takai", "takaye"].map(word));
const PRICE_DAME = new Set(["দামে", "dame"].map(word));
/** The price of one: "১৫০০ টাকা করে", "1500 taka kore", "প্রতি সেট ১৫০০ টাকা". */
const EACH_AFTER = new Set(["করে", "kore", "korey", "koira"].map(word));
const EACH_BEFORE = new Set(["প্রতি", "প্রতিটা", "proti", "protita", "per"].map(word));
const TAKA = new Set(["টাকা", "taka", "tk", "৳"].map(word));

/**
 * The price a sale's request sets (D176, D177): with টাকায় or দামে the price of what the line says, with করে or
 * প্রতি the price of one; always said as money (D157), so a quantity ("পাঁচ করে") or a payment's amount ("২০০০ টাকা
 * নগদ দিল") is never one. Null when the request sets none.
 */
export function salePriceOf(text: string): { amount: number; each: boolean } | null {
  const tokens = normalize(asciiDigits(text).replace(/(\d)[,،](?=\d{2,3}(\D|$))/g, "$1")).tokens;
  // The unbroken run of number words right before a token: "৩০০০ টাকায়", "তিন হাজার টাকায়".
  const runBefore = (index: number) => {
    let start = index;
    while (start > 0 && inNumberRun(tokens[start - 1]!)) start--;
    return start < index ? parseAmount(tokens.slice(start, index).join(" ")) : null;
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (LINE_PRICE.has(token)) {
      const amount = runBefore(index);
      if (amount !== null) return { amount, each: false };
    }
    if (PRICE_DAME.has(token) && index > 0 && TAKA.has(tokens[index - 1]!)) {
      const amount = runBefore(index - 1);
      if (amount !== null) return { amount, each: false };
    }
    if (EACH_AFTER.has(token) && index > 0 && TAKA.has(tokens[index - 1]!)) {
      const amount = runBefore(index - 1);
      if (amount !== null) return { amount, each: true };
    }
    if (EACH_BEFORE.has(token)) {
      // "প্রতি সেট ১৫০০ টাকা": a number then টাকা within the next few words
      const rest = tokens.slice(index + 1, index + 8);
      const taka = rest.findIndex((item) => TAKA.has(item) || LINE_PRICE.has(item));
      const amount = taka > 0 ? parseAmount(rest.slice(0, taka).join(" ")) : null;
      if (amount !== null) return { amount, each: true };
    }
  }
  return null;
}

/**
 * Whether a sale's request sets a price at all, read or not (D178): টাকায় or টাকাতে, or টাকা করে. A price whose
 * amount was misheard is then asked, never left out.
 */
export function saysSalePrice(text: string): boolean {
  const tokens = normalize(text).tokens;
  return tokens.some(
    (token, index) =>
      LINE_PRICE.has(token) || (EACH_AFTER.has(token) && index > 0 && TAKA.has(tokens[index - 1]!)),
  );
}

/** Every number a text says, in any form ("২০১৪", "দুই", "dui set", "১০ হাজার", "দুইটা"): what the user said, so a
 * number the model adds is not taken (D140). */
export function saidNumbers(text: string): Set<number> {
  const tokens = normalize(asciiDigits(text).replace(/(\d)[,،](?=\d{2,3}(\D|$))/g, "$1")).tokens;
  const numbers = new Set<number>();
  tokens.forEach((token, index) => {
    const amount = parseAmount(tokens.slice(index).join(" "));
    const value = valueOf(token);
    if (value !== null) numbers.add(value);
    if (amount !== null && valueOf(token) !== null) numbers.add(amount);
    const counted = parseQuantity([token]);
    if (counted) numbers.add(counted.value);
  });
  return numbers;
}
