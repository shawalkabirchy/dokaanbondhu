import { SEE_ON_SCREEN } from "./answers";
import { money } from "./format";
import { banglaDigits, isBangla, normalize } from "./text";

// Reminders (D194): parts running low and customers' old dues, asked for in Bangla or Banglish, and their answers. The
// sentences say how many and, when every name is in Bangla and there are few, the names; the list is on the screen
// (D160: the voice speaks Bangla, so a name in another script is shown, not said).

export type ReminderKind = "low_stock" | "old_dues";

/** A due older than this many days is old (D194). */
export const OLD_DUE_DAYS = 30;
/** Without a reorder level, a part at or below zero counts as low when it sold in this many days (D194). */
export const SOLD_DAYS = 90;
/** At most this many names are said (D160). */
const SAID_NAMES = 6;

const LOW_STOCK = [
  "কম আছে",
  "কম পড়েছে",
  "কম পড়ছে",
  "কমে গেছে",
  "কম স্টক",
  "স্টক কম",
  "ফুরিয়ে",
  "ফুরিয়েছে",
  "ফুরাচ্ছে",
  "শেষ হয়ে",
  "শেষ হচ্ছে",
  "অর্ডার দিতে হবে",
  "kom ache",
  "kom poreche",
  "kom porche",
  "kome geche",
  "kom stock",
  "stock kom",
  "low stock",
  "furiye",
  "furiyeche",
  "furacche",
  "shesh hoye",
  "shesh hocche",
  "order dite hobe",
];

const OLD_DUES = [
  "বাকি পুরোনো",
  "বাকি পুরনো",
  "বাকি পুরানো",
  "পুরোনো বাকি",
  "পুরনো বাকি",
  "পুরানো বাকি",
  "অনেক দিনের বাকি",
  "অনেকদিনের বাকি",
  "বাকি পড়ে আছে",
  "বাকি দেয়নি",
  "বাকি দেয় নাই",
  "baki purono",
  "baki purano",
  "purono baki",
  "purano baki",
  "onek diner baki",
  "onekdiner baki",
  "baki pore ache",
  "baki deyni",
  "old due",
  "old dues",
  "overdue",
];

const said = (tokens: string[], phrase: string) =>
  ` ${tokens.join(" ")} `.includes(` ${normalize(phrase).tokens.join(" ")} `);

/**
 * The reminder a request asks for (D194), or null: parts running low ("কী কী কম আছে?", "ki ki kom ache?") or old dues
 * ("কার বাকি পুরোনো?", "kar baki purono?"). Whether it is about one part ("এক্সিওর প্যাড কম আছে?") the turn decides: a
 * request that names a part or a car is a part search.
 */
export function reminderCueOf(text: string): ReminderKind | null {
  const tokens = normalize(text).tokens;
  if (!tokens.length) return null;
  if (OLD_DUES.some((phrase) => said(tokens, phrase))) return "old_dues";
  if (LOW_STOCK.some((phrase) => said(tokens, phrase))) return "low_stock";
  return null;
}

export interface LowStockLine {
  name: string;
  nameBn: string | null;
  stock: number;
}

export interface OldDueLine {
  name: string;
  nameBn: string | null;
  /** The whole due, and the part of it from sales older than OLD_DUE_DAYS (or older than any sale). */
  due: bigint;
  old: bigint;
}

/** The names to say: all of them, when there are few and each is in Bangla; else none (D160). */
function namesToSay(lines: { name: string; nameBn: string | null }[]): string[] | null {
  const names = [...new Set(lines.map((line) => line.nameBn ?? line.name))];
  return names.length <= SAID_NAMES && names.every((name) => isBangla(name)) ? names : null;
}

/** "৫টি পার্ট কম আছে: সেলফ মোটর, ডায়নামো। বিস্তারিত স্ক্রিনে দেখুন।" */
export function lowStockAnswer(lines: LowStockLine[]): string {
  if (!lines.length) return "এখন কোনো পার্ট কম নেই।";
  const names = namesToSay(lines);
  const count = `${banglaDigits(String(lines.length))}টি পার্ট কম আছে`;
  return `${count}${names ? `: ${names.join(", ")}` : ""}। ${SEE_ON_SCREEN}`;
}

/** "৩ জনের বাকি ৩০ দিনের বেশি পুরোনো, মোট ২৫,০০০ টাকা। বিস্তারিত স্ক্রিনে দেখুন।" */
export function oldDuesAnswer(lines: OldDueLine[], days = OLD_DUE_DAYS): string {
  const age = `${banglaDigits(String(days))} দিনের বেশি পুরোনো`;
  if (!lines.length) return `${age} বাকি কারো নেই।`;
  const total = lines.reduce((sum, line) => sum + line.old, 0n);
  const names = namesToSay(lines);
  const who = `${banglaDigits(String(lines.length))} জনের`;
  return `${who} বাকি ${age}, মোট ${money(total)}${names ? `: ${names.join(", ")}` : ""}। ${SEE_ON_SCREEN}`;
}
