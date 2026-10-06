import { money, quantity as quantityText, year as yearText } from "./format";
import { GLOSSARY, type AliasConcept } from "./glossary";
import type { PartRow, SeparatingSlot, SlotOption } from "./resolve";
import { banglaDigits } from "./text";

// Template questions and answers (spec 9.4, 12.2): deterministic Bangla, never LLM text. Parts answers follow the
// architecture's example; a field the host does not record is left out, never invented.

const BN_COUNT = ["শূন্য", "এক", "দুই", "তিন", "চার", "পাঁচ", "ছয়", "সাত", "আট", "নয়", "দশ"];

/** The Bangla word of a glossary value (Toyota Axio -> এক্সিও, aftermarket -> নন-জেনুইন), else the value. */
export function banglaOf(concept: AliasConcept, value: string): string {
  // Two positions at once, "front left", are said "সামনের বাম" (D122).
  if (concept === "position" && value.includes(" "))
    return value
      .split(" ")
      .map((part) => banglaOf(concept, part))
      .join(" ");
  return (
    GLOSSARY.find((entry) => entry.target_concept === concept && entry.target_value === value)?.bn[0] ?? value
  );
}

const VOWEL_ENDS = new Set([..."ািীুূৃেৈোৌঅআইঈউঊঋএঐওঔ"]);

/** Bangla consonants by code point: ক to হ, the nukta that ends ড় and ঢ় after NFC, ড় to য়, ৎ and ং. */
function isConsonant(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x0995 && code <= 0x09b9) ||
    code === 0x09bc ||
    (code >= 0x09dc && code <= 0x09df) ||
    code === 0x09ce ||
    code === 0x0982
  );
}

function ending(text: string): "vowel" | "consonant" | "other" {
  const last = [...text.trimEnd()].at(-1) ?? "";
  if (VOWEL_ENDS.has(last)) return "vowel";
  if (isConsonant(last)) return "consonant";
  return "other";
}

/** Possessive: এক্সিওর, রহিম মোটরসের, এক্সিও ২০১৪-এর. */
export function possessive(text: string): string {
  return text + { vowel: "র", consonant: "ের", other: "-এর" }[ending(text)];
}

/** How many kinds: দুই রকম (words up to ten, then digits). */
export function kindsCount(count: number): string {
  return `${BN_COUNT[count] ?? banglaDigits(String(count))} রকম`;
}

export interface PartsContext {
  vehicle: string; // glossary value, e.g. Toyota Axio
  year: number | null;
  /** When no year was asked: the year range the parts fit. */
  yearRange?: [number, number | null] | null;
  partType: string; // glossary value, e.g. Brake Pad
  position: string | null;
  tier: "retail" | "garage" | "wholesale";
  /** The customer whose tier it is (session context), named when the answer uses that price (D119). */
  customer?: string;
}

const TIER_BN = { retail: "খুচরা", garage: "গ্যারেজ", wholesale: "পাইকারি" } as const;

function vehiclePhrase(context: PartsContext): string {
  const vehicle = banglaOf("vehicle_model", context.vehicle);
  if (context.year) return `${vehicle} ${yearText(context.year)}`;
  if (context.yearRange) {
    const [from, to] = context.yearRange;
    return `${vehicle} ${yearText(from)}${to ? `–${yearText(to)}` : ""}`;
  }
  return vehicle;
}

/** "এক্সিও ২০১৪-এর সামনের প্যাড". */
export function partPhrase(context: PartsContext, partType = context.partType): string {
  const position = context.position ? `${banglaOf("position", context.position)} ` : "";
  return `${possessive(vehiclePhrase(context))} ${position}${banglaOf("part_type", partType)}`;
}

function priceOf(row: PartRow, tier: PartsContext["tier"]): bigint | null {
  const tierPrice = tier === "garage" ? row.garageTaka : tier === "wholesale" ? row.wholesaleTaka : null;
  return tierPrice ?? row.retailTaka;
}

function stockText(row: PartRow): string {
  if (row.stock === null) return "";
  if (row.stock <= 0) return "নেই";
  return quantityText(row.stock, row.unit ?? "piece");
}

/** Where a part is kept: "B-3", or "B-3 আর G-1" when it is on several racks (D122). */
export function rackText(row: PartRow): string | null {
  const racks = row.racks?.length ? row.racks : row.rack ? [row.rack] : [];
  if (!racks.length) return null;
  return racks.length === 1 ? racks[0]! : `${racks.slice(0, -1).join(", ")} আর ${racks.at(-1)}`;
}

/** One kind: "জেনুইন ৩ সেট, ৪,৫০০ টাকা" (rack added by the caller when it differs); the brand when two kinds share
 * a quality, "নন-জেনুইন (Denso) ১০টা", so they can be told apart. */
function kindText(row: PartRow, tier: PartsContext["tier"], withRack: boolean, withBrand = false): string {
  const bits: string[] = [];
  const stock = stockText(row);
  const quality = row.quality ? banglaOf("quality", row.quality) : null;
  const brand = withBrand && row.brand ? `(${row.brand})` : null;
  const head = [quality, brand, stock].filter(Boolean).join(" ");
  if (head) bits.push(head);
  const price = priceOf(row, tier);
  if (price !== null && (row.stock ?? 1) > 0) bits.push(money(price));
  const rack = rackText(row);
  if (withRack && rack && (row.stock ?? 1) > 0) bits.push(`${rack} তাকে`);
  return bits.join(", ");
}

/** "এক্সিও ২০১৪-এর পেছনের লাইনিং জেনুইন নেই।": the asked quality or brand is missing (D95). */
export function missingAnswer(
  context: PartsContext,
  missing: string,
  pairUsed: string | null = null,
): string {
  return `${partPhrase(context, pairUsed ?? context.partType)} ${missing} নেই।`;
}

/** "দাম নিউ ঢাকা গ্যারেজের রেটে।" when a price said is the customer's tier price, not retail (D119). */
function rateSentence(rows: PartRow[], context: PartsContext): string {
  if (context.tier === "retail") return "";
  const differs = rows.some((row) => {
    const price = priceOf(row, context.tier);
    return (row.stock ?? 1) > 0 && price !== null && price !== row.retailTaka;
  });
  if (!differs) return "";
  return ` দাম ${context.customer ? possessive(context.customer) : TIER_BN[context.tier]} রেটে।`;
}

/** Said when a fit is read only from a part's name or notes, never confirmed by the app's records (D122). */
function fromNameSentence(rows: PartRow[]): string {
  const named = rows.filter((row) => row.fitFromName).length;
  if (!named) return "";
  return named === rows.length
    ? " এই গাড়িতে লাগে বলে নামে লেখা আছে, নিশ্চিত নয়।"
    : " কয়েকটা এই গাড়িতে লাগে বলে শুধু নামে লেখা আছে, নিশ্চিত নয়।";
}

/**
 * The parts answer (architecture, A.1): one kind in one sentence, several with "দুই রকম" and a shared rack. A position
 * not asked is said when every kind shares it (D120); the customer's rate is named when it was used (D119).
 */
export function partsAnswer(rows: PartRow[], asked: PartsContext, pairUsed: string | null = null): string {
  const positions = new Set(rows.map((row) => row.position));
  const onePosition = positions.size === 1 ? [...positions][0]! : null;
  const context = { ...asked, position: asked.position ?? onePosition };
  const subject = partPhrase(context, pairUsed ?? context.partType);
  const inStock = rows.filter((row) => row.stock === null || row.stock > 0);
  if (inStock.length === 0) return `${subject} এখন স্টকে নেই।`;
  const rate = rateSentence(rows, context) + fromNameSentence(rows);
  if (rows.length === 1) {
    const row = rows[0]!;
    const quality = row.quality ? `${banglaOf("quality", row.quality)} ` : "";
    const [head, ...tail] = [
      `${possessive(vehiclePhrase(context))} ${context.position ? `${banglaOf("position", context.position)} ` : ""}${quality}${banglaOf("part_type", pairUsed ?? context.partType)} ${stockText(row)} আছে`,
      ...(priceOf(row, context.tier) !== null ? [money(priceOf(row, context.tier)!)] : []),
      ...(rackText(row) ? [`${rackText(row)} তাকে`] : []),
    ];
    return `${[head, ...tail].join(", ")}।${rate}`;
  }
  const racks = new Set(inStock.map((row) => rackText(row)));
  const sharedRack = racks.size === 1 ? [...racks][0] : null;
  const qualities = rows.map((row) => row.quality ?? "");
  const shared = (row: PartRow) => qualities.filter((quality) => quality === (row.quality ?? "")).length > 1;
  const kinds = rows.map((row) => kindText(row, context.tier, !sharedRack, shared(row))).join("; ");
  const both = rows.length === 2 ? "দুটোই" : "সবগুলো";
  const rack = sharedRack ? ` ${both} ${sharedRack} তাকে।` : "";
  return `${subject} ${kindsCount(rows.length)} আছে: ${kinds}।${rack}${rate}`;
}

/** No recorded fitment: said plainly, with the offers marked as not recorded for this car (architecture, step 5). */
export function noFitmentAnswer(context: PartsContext, offers: PartRow[]): string {
  const base = `${partPhrase(context)} রেকর্ডে পাওয়া যায়নি।`;
  if (!offers.length) return base;
  const names = offers
    .slice(0, 2)
    .map((row) => row.nameBn ?? row.name)
    .join(", ");
  return `${base} কাছাকাছি: ${names}; এই গাড়িতে লাগে কি না রেকর্ডে নেই।`;
}

export function dueAnswer(customer: string, taka: bigint): string {
  return taka > 0n
    ? `${possessive(customer)} বাকি ${money(taka)}।`
    : `${possessive(customer)} কোনো বাকি নেই।`;
}

export const SEE_IN_APP = "এটা আপনার অ্যাপে দেখুন।";
export const SEE_ON_SCREEN = "বিস্তারিত স্ক্রিনে দেখুন।";
export const ASK_AGAIN = "আবার বলবেন?";
export const CANNOT_ANSWER_NOW = "এখন উত্তর দিতে পারছি না, একটু পরে আবার চেষ্টা করুন।";

/** The fixed help answer: what the assistant can do (spec 12.2). */
export function helpAnswer(actions: string[] = []): string {
  const extra = actions.length ? `, আর ${actions.join(", ")}` : "";
  return `আমি পার্ট খুঁজতে পারি (স্টক, দাম, কোন তাকে, কোন গাড়িতে লাগে), বাকি আর বিক্রির হিসাব বলতে পারি${extra}। কী লাগবে বলুন।`;
}

export type QuestionSlot =
  | "vehicle"
  | "year"
  | "engine"
  | "position"
  | "quality"
  | "part_type"
  | "customer"
  | "supplier"
  | "sale_ref"
  | "quantity"
  | "unit_cost"
  | "unit_price"
  | "payment"
  | "amount"
  | "trx_id"
  | "other";

/** Slots are asked in this order (spec 9.4). */
export const QUESTION_ORDER: QuestionSlot[] = [
  "vehicle",
  "year",
  "engine",
  "position",
  "quality",
  "part_type",
  "customer",
  "supplier",
  "sale_ref",
  "quantity",
  "unit_cost",
  "unit_price",
  "payment",
  "amount",
  "trx_id",
  "other",
];

export interface QuestionInput {
  slot: QuestionSlot;
  /** What is already understood, said first: "রহিম মোটরস, এক্সিওর সামনের ব্রেক প্যাড". */
  understood?: string;
  vehicle?: string; // glossary value, for the year question
  unit?: string;
  names?: string[]; // for customer or supplier
  label?: string; // for other
}

/** The template question for one slot (spec 9.4). */
export function question(input: QuestionInput): string {
  let text: string;
  switch (input.slot) {
    case "year":
      text = `কোন বছরের ${input.vehicle ? banglaOf("vehicle_model", input.vehicle) : "গাড়ি"}?`;
      break;
    case "quality":
      text = "জেনুইন না নন-জেনুইন?";
      break;
    case "position":
      text = "সামনের না পেছনের?";
      break;
    case "engine":
      text = "কোন ইঞ্জিন?";
      break;
    case "customer":
    case "supplier":
      text =
        input.names && input.names.length >= 2 ? `${input.names[0]} নাকি ${input.names[1]}?` : "কার নামে?";
      break;
    case "quantity":
      text = `কয় ${input.unit ? quantityUnit(input.unit) : "টা"}?`;
      break;
    case "unit_cost":
      text = `প্রতি ${input.unit ? quantityUnit(input.unit) : "টা"} কেনা দাম কত?`;
      break;
    case "payment":
      text = "বাকিতে না নগদে?";
      break;
    case "trx_id":
      text = "ট্রানজেকশন আইডি বলবেন? না থাকলে “পরে” বলুন।";
      break;
    case "vehicle":
      text = "কোন গাড়ির?";
      break;
    case "part_type":
      text = "কোন পার্ট লাগবে?";
      break;
    default:
      text = `${input.label ?? "আরেকটু"} বলবেন?`;
  }
  return input.understood ? `${input.understood} — ${text}` : text;
}

function quantityUnit(unit: string): string {
  return { piece: "টা", set: "সেট", pair: "জোড়া", liter: "লিটার", box: "বক্স", tin: "টিন" }[unit] ?? unit;
}

/** A separating slot's options as chips: label, and "৪,৫০০ টাকা, ৩টা আছে". */
export function slotChips(
  slot: SeparatingSlot,
  options: SlotOption[],
): { id: string; label: string; sublabel: string }[] {
  return options.map((option, index) => {
    const concept: AliasConcept | null =
      slot === "quality" ? "quality" : slot === "position" ? "position" : slot === "brand" ? "brand" : null;
    const label =
      concept !== null
        ? banglaOf(concept, option.value)
        : slot === "year"
          ? option.value
              .split("-")
              .map((part) => (part ? yearText(Number(part)) : ""))
              .join("–")
          : option.value;
    const unit = option.rows[0]?.unit ?? "piece";
    const bits = [
      option.priceTaka !== null ? money(option.priceTaka) : null,
      option.stock > 0 ? `${quantityText(option.stock, unit)} আছে` : "নেই",
    ];
    return { id: `opt-${index + 1}`, label, sublabel: bits.filter(Boolean).join(", ") };
  });
}
