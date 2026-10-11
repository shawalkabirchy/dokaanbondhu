import {
  banglaOf,
  isNumberWord,
  knownWords,
  matchConcept,
  namesInText,
  normalize,
  soundOf,
  soundSimilarity,
  type CatalogCustomer,
  type Dictionary,
} from "@dokaanbondhu/core";
import { z } from "zod";
import { llmStream, type LlmProvider } from "../providers";

// The LLM understands near words (D149 C, D153). Speech-to-text writes shop words its own way (এসডিও for এক্সিও,
// নাওয়াবপুর অটোপাস for Nawabpur Auto Parts Ltd.); a word the matcher cannot place is shown to the LLM with the shop's
// nearest names, how each sounds in Latin letters and the other speech hypotheses, and the LLM says which name was
// meant from the whole sentence. Only a listed name is taken; the sentence then goes on as if it had been said so.

export type NearKind = "vehicle_model" | "part_type" | "customer" | "supplier";

export interface NearOption {
  kind: NearKind;
  /** The catalog value or stored name: Toyota Axio, Nawabpur Auto Parts Ltd. */
  value: string;
  /** The word put into the sentence: এক্সিও, Nawabpur Auto Parts Ltd. */
  label: string;
  sound: string;
  similarity: number;
}

export interface NearHint {
  /** The words as heard, normalized: "এসডিও". */
  heard: string;
  sound: string;
  start: number;
  size: number;
  options: NearOption[];
}

/** Hints are offered from this sound similarity on, at most three per word and five per sentence. */
const NEAR_SOUND = 0.55;
/** A word that sounds this much like an everyday word is that word misheard ("সেন্ট" for "সেট"), never a name. */
const EVERYDAY_SOUND = 0.75;
/** Hundreds said as one word: দুইশ, তিনশো. */
const HUNDREDS = /^(এক|দুই|দু|তিন|চার|পাঁচ|ছয়|ছ|সাত|আট|নয়)শো?$/u;
/**
 * How close the LLM's answer must sound to a listed name to be that name, written in the other script (New Dhaka
 * Garage written নিউ ঢাকা গ্যারেজ sounds 0.62 alike).
 */
const SAME_NAME = 0.5;
const OPTIONS = 3;
const HINTS = 5;

/** Everyday words never taken for a misheard name. */
const EVERYDAY = new Set(
  [
    "আছে",
    "আছেন",
    "কত",
    "দাম",
    "কি",
    "কী",
    "এর",
    "এ",
    "ও",
    "আর",
    "দাও",
    "দিন",
    "দেন",
    "নাও",
    "নিলাম",
    "কিনলাম",
    "থেকে",
    "কে",
    "টা",
    "টি",
    "টাকা",
    "সেট",
    "পিস",
    "জোড়া",
    "প্রতি",
    "বাকিতে",
    "নগদে",
    "হ্যাঁ",
    "না",
    "জি",
    "ঠিক",
    "ভাই",
    "একটা",
    "সামনের",
    "সামনে",
    "পেছনের",
    "পিছনের",
    "জমা",
    "মোট",
    "বিক্রি",
    "বাকি",
    "বা",
    "আজকে",
    "আজ",
    "কাল",
    "হবে",
    "করো",
    "কর",
    "দেখাও",
    "বলো",
    "কোন",
    "কোনটা",
    "গাড়ির",
    "গাড়ি",
    "র‍্যাকে",
    "র‍্যাক",
    "রেকে",
    "তাকে",
    "তাক",
    "ঢাকায়",
    "ঢাকা",
    "ache",
    "koto",
    "dam",
    "ki",
    "er",
    "ar",
    "dao",
    "din",
    "nao",
    "nilam",
    "kinlam",
    "theke",
    "ke",
    "ta",
    "taka",
    "set",
    "pis",
    "proti",
    "bakite",
    "nogode",
    "ha",
    "na",
    "ji",
    "thik",
    "bhai",
    "ekta",
    "samner",
    "pechoner",
    "joma",
    "baki",
    "ajke",
    "hobe",
    "koro",
    "rack",
    "rake",
    "take",
    "dhakay",
    "dhaka",
  ].map((word) => normalize(word).tokens.join(" ")),
);

export interface NearInput {
  text: string;
  dictionary: Dictionary;
  customers: readonly CatalogCustomer[];
  suppliers: readonly CatalogCustomer[];
}

interface Spelling {
  kind: NearKind;
  value: string;
  label: string;
  text: string;
}

/** Every car model, part type and name of the shop, each spelling with the word it is put back as. */
function vocabulary(input: NearInput): Spelling[] {
  const spellings: Spelling[] = [];
  for (const term of input.dictionary.terms) {
    if (term.concept !== "vehicle_model" && term.concept !== "part_type") continue;
    spellings.push({
      kind: term.concept,
      value: term.value,
      label: banglaOf(term.concept, term.value),
      text: term.text,
    });
  }
  for (const [kind, people] of [
    ["customer", input.customers],
    ["supplier", input.suppliers],
  ] as const) {
    for (const person of people) {
      for (const text of [person.name, person.nameBn].filter((name): name is string => Boolean(name))) {
        spellings.push({ kind, value: person.name, label: person.name, text });
      }
    }
  }
  return spellings;
}

/** The token spans the matcher already understands: a car, part, quality or name said well enough. */
function placedSpans(input: NearInput, tokens: readonly string[]): [number, number][] {
  const spans: [number, number][] = [];
  const mark = (heard: string) => {
    const words = heard.split(" ");
    for (let start = 0; start + words.length <= tokens.length; start++) {
      if (words.every((word, offset) => tokens[start + offset] === word))
        spans.push([start, start + words.length]);
    }
  };
  for (const concept of ["vehicle_model", "part_type", "quality", "position", "brand"] as const) {
    for (const candidate of matchConcept(concept, input.text, [], input.dictionary).candidates) {
      if (candidate.score >= 0.7) mark(normalize(candidate.heard).tokens.join(" "));
    }
  }
  const names = [...input.customers, ...input.suppliers].map((person) => ({
    kind: "name",
    name: person.name,
  }));
  for (const found of namesInText(input.text, names, input.dictionary))
    mark(normalize(found.heard).tokens.join(" "));
  return spans;
}

/**
 * The words of a sentence the matcher cannot place, each with the shop's nearest names by sound (D153): a run of one
 * to three words with at least one word that is neither everyday, a number nor a known word.
 */
export function nearHints(input: NearInput): NearHint[] {
  const tokens = normalize(input.text, input.dictionary.variants).tokens;
  if (!tokens.length) return [];
  const known = knownWords(input.dictionary);
  const placed = placedSpans(input, tokens);
  const everyday = [...EVERYDAY];
  const numeric = (token: string) => isNumberWord(token) || HUNDREDS.test(token);
  const unclear = (token: string) =>
    !EVERYDAY.has(token) &&
    !numeric(token) &&
    !known.has(token) &&
    token.length > 1 &&
    !everyday.some((word) => soundSimilarity(token, word) >= EVERYDAY_SOUND);
  const spellings = vocabulary(input);
  const hints: NearHint[] = [];
  for (let size = Math.min(3, tokens.length); size >= 1; size--) {
    for (let start = 0; start + size <= tokens.length; start++) {
      const words = tokens.slice(start, start + size);
      if (!words.some(unclear) || words.some(numeric)) continue;
      if (EVERYDAY.has(words[0]!) || EVERYDAY.has(words.at(-1)!)) continue; // a name never starts or ends so
      if (placed.some(([from, to]) => start < to && start + size > from)) continue;
      const heard = words.join(" ");
      const best = new Map<string, NearOption>();
      for (const spelling of spellings) {
        const similarity = soundSimilarity(heard, spelling.text);
        if (similarity < NEAR_SOUND) continue;
        const key = `${spelling.kind}|${spelling.value}`;
        const seen = best.get(key);
        if (!seen || similarity > seen.similarity)
          best.set(key, {
            kind: spelling.kind,
            value: spelling.value,
            label: spelling.label,
            sound: soundOf(spelling.text),
            similarity,
          });
      }
      const options = [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, OPTIONS);
      if (options.length) hints.push({ heard, sound: soundOf(heard), start, size, options });
    }
  }
  // The best hints that do not overlap, the closer first; a longer run wins a near tie, so a two-word name is taken
  // whole ("নওয়াপুর অটোপাস", not "নওয়াপুর" alone).
  const rank = (hint: NearHint) => hint.options[0]!.similarity + 0.05 * (hint.size - 1);
  hints.sort((a, b) => rank(b) - rank(a));
  const chosen: NearHint[] = [];
  for (const hint of hints) {
    const end = hint.start + hint.size;
    if (chosen.some((other) => hint.start < other.start + other.size && end > other.start)) continue;
    chosen.push(hint);
    if (chosen.length === HINTS) break;
  }
  return chosen.sort((a, b) => a.start - b.start);
}

/** Typical mistakes of our speech-to-text, from the owner's voice tests (data/heard-as.jsonl), as examples. */
const EXAMPLES = [
  ["এক জিও", "এক্সিও"],
  ["এসডিও", "এক্সিও"],
  ["দোহা", "নোয়া"],
  ["ব্রেকপ্যাট", "ব্রেক প্যাড"],
  ["ব্রেক পেড", "ব্রেক প্যাড"],
  ["বাতিতে", "বাকিতে"],
  ["রহিম মোটরগে", "রহিম মোটরস"],
  ["নাওয়াবপুর অটোপাস", "নবাবপুর অটো পার্টস"],
] as const;

export const CLEANUP_PROMPT = `You correct speech-to-text mistakes in one sentence said in a car spare parts shop in
Bangladesh. The speech-to-text writes the shop's words wrongly, for example: ${EXAMPLES.map(
  ([heard, meant]) => `"${heard}" for "${meant}"`,
).join(", ")}.
Most words are ordinary Bangla words and are right as they are. For each unclear word you get the shop's nearest
names and how each sounds in Latin letters. Change a word only when it is clearly a misheard shop name that fits the
sentence (a year goes with a car, a quantity with a part, "থেকে" with a supplier, "কে" with a customer). Never change
numbers, prices, quantities or ordinary words. If the sentence is not about the shop, change nothing. Use only a
listed name, as it is listed (a customer's or supplier's name may be in Latin letters, and may be said with an ending
such as কে, এর or ের); if none fits, leave the word out.
Reply with JSON only: {"replaced":[{"heard":"<the unclear word as given>","meant":"<a listed name>"}]}`;

const cleanupSchema = z.object({
  replaced: z.array(z.object({ heard: z.string(), meant: z.string() })).default([]),
});

export interface Cleaned {
  text: string;
  replaced: { heard: string; option: NearOption }[];
}

/** The user message of the clean-up call: the sentence, the question it answers, the other hypotheses, the options. */
export function cleanupMessage(
  text: string,
  others: readonly string[],
  hints: readonly NearHint[],
  question?: string,
): string {
  const lines = [`Sentence: ${text}`];
  if (question) lines.push(`It answers the shop's question: ${question}`);
  if (others.length) lines.push(`Other guesses of the speech-to-text: ${others.join(" | ")}`);
  lines.push("Unclear words:");
  for (const hint of hints) {
    const options = hint.options.map((option) => `${option.label} (${option.sound})`).join(" | ");
    lines.push(`- "${hint.heard}" (${hint.sound}): ${options}`);
  }
  return lines.join("\n");
}

/** Applies the LLM's choices: only a listed option for a listed word; the sentence is rebuilt from its tokens. */
export function applyCleanup(
  text: string,
  hints: readonly NearHint[],
  reply: unknown,
  dictionary: Dictionary,
): Cleaned {
  const parsed = cleanupSchema.safeParse(reply);
  if (!parsed.success) return { text, replaced: [] };
  const same = (a: string, b: string) => normalize(a).tokens.join(" ") === normalize(b).tokens.join(" ");
  // The LLM may write a listed name in the other script ("নবাবপুর অটো পার্টস" for Nawabpur Auto Parts Ltd.): the
  // listed option that sounds most like its answer is taken, and nothing that is not listed.
  const optionFor = (hint: NearHint, meant: string) => {
    const exact = hint.options.find((option) => same(option.label, meant) || same(option.value, meant));
    if (exact) return exact;
    // An ending the LLM kept (গ্যারেজের, মোটরসকে) is not part of the name.
    const bare = meant.trim().replace(/(ের|এর|কে|র)$/u, "");
    const scored = hint.options
      .map((option) => {
        const name = option.label.replace(/ (ltd|limited)\.?$/i, "");
        return { option, score: Math.max(soundSimilarity(meant, name), soundSimilarity(bare, name)) };
      })
      .sort((a, b) => b.score - a.score);
    const [first, second] = scored;
    if (!first || first.score < SAME_NAME) return undefined;
    // With several options the answer must sound clearly like one of them.
    return !second || first.score - second.score >= 0.1 ? first.option : undefined;
  };
  const replaced: Cleaned["replaced"] = [];
  for (const choice of parsed.data.replaced) {
    const hint = hints.find((candidate) => same(candidate.heard, choice.heard));
    const option = hint ? optionFor(hint, choice.meant) : undefined;
    if (hint && option && !replaced.some((done) => done.heard === hint.heard))
      replaced.push({ heard: hint.heard, option });
  }
  if (!replaced.length) return { text, replaced };
  // The sentence as said, with only the misheard words swapped: each word of the text is mapped to its tokens, so
  // ২০১৪ stays ২০১৪ and punctuation stays.
  const words = text.split(/\s+/).filter(Boolean);
  const owner: number[] = [];
  words.forEach((word, index) => {
    const count = normalize(word, dictionary.variants).tokens.length;
    for (let token = 0; token < count; token++) owner.push(index);
  });
  const swaps = new Map<number, { last: number; label: string }>();
  for (const { heard, option } of replaced) {
    const hint = hints.find((candidate) => candidate.heard === heard)!;
    const first = owner[hint.start];
    const last = owner[hint.start + hint.size - 1];
    if (first === undefined || last === undefined) continue;
    swaps.set(first, { last, label: option.label });
  }
  const out: string[] = [];
  for (let index = 0; index < words.length;) {
    const swap = swaps.get(index);
    if (swap) {
      out.push(swap.label);
      index = swap.last + 1;
    } else {
      out.push(words[index]!);
      index += 1;
    }
  }
  return { text: out.join(" "), replaced };
}

/**
 * One short LLM call that picks the meant names (under a second on the pod, about four on Cloudflare in development);
 * any failure or a call past eight seconds leaves the sentence as it was.
 */
export async function cleanTranscript(
  llm: LlmProvider[],
  text: string,
  others: readonly string[],
  hints: readonly NearHint[],
  dictionary: Dictionary,
  question?: string,
): Promise<Cleaned> {
  if (!hints.length || !llm.length) return { text, replaced: [] };
  let reply = "";
  try {
    for await (const delta of llmStream(
      llm,
      {
        messages: [
          { role: "system", content: CLEANUP_PROMPT },
          { role: "user", content: cleanupMessage(text, others, hints, question) },
        ],
        toolChoice: "none",
        temperature: 0,
        maxTokens: 200,
      },
      { startTimeoutMs: 4000, deadlineMs: 8000 }, // as long as the turn's own calls may take
    )) {
      if (delta.type === "text") reply += delta.text;
    }
    const start = reply.indexOf("{");
    const end = reply.lastIndexOf("}");
    if (start < 0 || end < start) return { text, replaced: [] };
    return applyCleanup(text, hints, JSON.parse(reply.slice(start, end + 1)), dictionary);
  } catch {
    return { text, replaced: [] };
  }
}
