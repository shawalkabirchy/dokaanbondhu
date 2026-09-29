import {
  aliasEntries,
  buildDictionary,
  checkedSpellings,
  GLOSSARY,
  isBangla,
  learnableWords,
  phoneticKey,
  type Dictionary,
} from "@dokaanbondhu/core";
import { aiProviders, aliases, speechChecks, type Tx } from "@dokaanbondhu/platform-db";
import { eq, isNull, or } from "drizzle-orm";
import {
  llmChain,
  llmStream,
  OWN_SIDE,
  selectProviders,
  sttAdapter,
  ttsAdapter,
  type LlmProvider,
} from "../providers";
import { loadCatalog, type Catalog } from "./catalog";

// The listening check (D102 A): after a catalog sync, our own voice says each car model and part type of the shop, our
// own speech-to-text writes it down, and the ways it writes them that the dictionary lacks become the shop's aliases
// (source asr_check). Each name is checked once (speech_checks); at most 500 names per shop, a batch per run.

export const MAX_CHECKS_PER_SHOP = 500;
const PER_RUN = 60;
/** Said after the name, so the name is heard as in a question, not alone; dropped from what was heard. */
const CARRIER = "আছে?";

export interface NameToCheck {
  concept: "vehicle_model" | "part_type";
  value: string;
  /** The shop's usual Bangla word for it; null for a name the dictionary has no Bangla word for (a new host's car). */
  spoken: string | null;
}

/** The shop's car models and the part types it stocks (a type whose word is in a part's name), with their Bangla word. */
export function namesToCheck(catalog: Catalog, dictionary: Dictionary): NameToCheck[] {
  const firstBangla = (concept: NameToCheck["concept"], value: string) =>
    dictionary.terms.find((term) => term.concept === concept && term.value === value && isBangla(term.text))
      ?.text ?? null;
  const names: NameToCheck[] = [];
  const models = new Set(catalog.vehicles.map((vehicle) => `${vehicle.make} ${vehicle.model}`.trim()));
  for (const value of models)
    names.push({ concept: "vehicle_model", value, spoken: firstBangla("vehicle_model", value) });
  const types = new Set(
    dictionary.terms.filter((term) => term.concept === "part_type").map((term) => term.value),
  );
  for (const value of types) {
    const needle = value.toLowerCase();
    if (catalog.parts.some((part) => part.name.toLowerCase().includes(needle)))
      names.push({ concept: "part_type", value, spoken: firstBangla("part_type", value) });
  }
  return names;
}

/** Bangla words for names the dictionary has none for, asked once of the shop's LLM: "name = বাংলা" per line. */
export async function banglaSpellings(names: string[], llm: LlmProvider[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!names.length || !llm.length) return found;
  const prompt =
    "Write how the staff of a car spare parts shop in Bangladesh say each of these names, in Bangla script. " +
    'One line per name, exactly "name = বাংলা", nothing else.\n' +
    names.join("\n");
  let text = "";
  for await (const delta of llmStream(
    llm,
    { messages: [{ role: "user", content: prompt }], temperature: 0, maxTokens: 800 },
    { startTimeoutMs: 10_000, deadlineMs: 30_000 },
  )) {
    if (delta.type === "text") text += delta.text;
  }
  for (const line of text.split("\n")) {
    const split = line.lastIndexOf("=");
    if (split < 0) continue;
    const name = line.slice(0, split).trim();
    const bangla = line.slice(split + 1).trim();
    if (names.includes(name) && isBangla(bangla) && bangla.length <= 40) found.set(name, bangla);
  }
  return found;
}

export interface SpeechCheckResult {
  checked: number;
  added: number;
  skipped: number;
  /** Names still to check after this run. */
  left: number;
  /** Why the run stopped early (speech-to-text or text-to-speech down): the rest is checked next time. */
  stopped?: string;
}

export async function runSpeechCheck(
  withAdmin: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  aesKey: Buffer,
  shopId: string,
  connectionId: string,
  options: { limit?: number; voice?: string; log?: (line: string) => void } = {},
): Promise<SpeechCheckResult> {
  const { catalog, own, providers, checked } = await withAdmin(async (tx) => ({
    catalog: await loadCatalog(tx, connectionId),
    own: await tx.select().from(aliases).where(eq(aliases.shopId, shopId)),
    providers: await tx
      .select()
      .from(aiProviders)
      .where(or(eq(aiProviders.shopId, shopId), isNull(aiProviders.shopId))),
    checked: await tx
      .select({ concept: speechChecks.targetConcept, value: speechChecks.targetValue })
      .from(speechChecks)
      .where(eq(speechChecks.shopId, shopId)),
  }));
  const learned = [...own];
  let dictionary = buildDictionary([...GLOSSARY, ...aliasEntries(learned)]);
  const done = new Set(checked.map((row) => `${row.concept}|${row.value}`));
  const todo = namesToCheck(catalog, dictionary).filter((name) => !done.has(`${name.concept}|${name.value}`));
  const room = Math.max(0, MAX_CHECKS_PER_SHOP - checked.length);
  const batch = todo.slice(0, Math.min(options.limit ?? PER_RUN, room));
  const result: SpeechCheckResult = { checked: 0, added: 0, skipped: 0, left: todo.length };
  if (!batch.length) return result;

  // Our own speech models only (D102): the check never sends the shop's names to a paid service.
  const used = selectProviders(providers, shopId, OWN_SIDE);
  const stt = used.stt ? sttAdapter(used.stt, aesKey) : null;
  const tts = used.tts ? ttsAdapter(used.tts, aesKey) : null;
  if (!stt || !tts) return { ...result, stopped: "no speech worker for this shop" };

  const unspelled = batch.filter((name) => !name.spoken).map((name) => name.value);
  const spellings = await banglaSpellings(unspelled, llmChain(providers, shopId, OWN_SIDE, aesKey)).catch(
    () => new Map<string, string>(),
  );

  for (const name of batch) {
    const spoken = name.spoken ?? spellings.get(name.value);
    if (!spoken) {
      result.skipped++;
      continue; // no Bangla word yet: tried again next time
    }
    let hypotheses: string[];
    try {
      const audio = await tts.synthesize(`${spoken} ${CARRIER}`, { voice: options.voice ?? "aditi" });
      const asr = await stt.transcribe(audio.bytes, { keyterms: [], nbest: 5, lowConfidenceBelow: 0.5 });
      hypotheses = asr.nbest.length ? asr.nbest.map((hypothesis) => hypothesis.text) : [asr.text];
    } catch (error) {
      return { ...result, stopped: error instanceof Error ? error.message : String(error) };
    }
    const { heard, keep } = checkedSpellings(spoken, hypotheses, dictionary);
    // A new host's name: its Bangla word (from the LLM) is kept too, so a request with it is understood.
    const ownWord = name.spoken ? null : learnableWords(spoken, dictionary);
    const words = [...new Set([...(ownWord ? [ownWord] : []), ...keep])];
    const rows = words.map((word) => ({
      shopId,
      aliasText: word,
      aliasNormalized: word,
      aliasPhonetic: phoneticKey(word),
      targetConcept: name.concept,
      targetValue: name.value,
      source: "asr_check",
    }));
    await withAdmin(async (tx) => {
      if (rows.length) await tx.insert(aliases).values(rows);
      await tx
        .insert(speechChecks)
        .values({
          shopId,
          targetConcept: name.concept,
          targetValue: name.value,
          spoken,
          heard,
          added: rows.length,
        })
        .onConflictDoNothing();
    });
    if (rows.length) {
      // Known at once, so a later name never takes these words.
      learned.push(...rows.map((row) => ({ ...row, id: "", createdAt: new Date() })));
      dictionary = buildDictionary([...GLOSSARY, ...aliasEntries(learned)]);
    }
    result.checked++;
    result.added += rows.length;
    result.left--;
    options.log?.(
      `${name.value}: said "${spoken}", heard ${JSON.stringify(heard)}, added ${JSON.stringify(words)}`,
    );
  }
  return result;
}
