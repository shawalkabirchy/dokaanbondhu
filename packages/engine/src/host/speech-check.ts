import {
  aliasEntries,
  buildDictionary,
  checkedSpellings,
  GLOSSARY,
  isBangla,
  learnableWords,
  type Dictionary,
} from "@dokaanbondhu/core";
import { aiProviders, aliases, aliasSuggestions, speechChecks, type Tx } from "@dokaanbondhu/platform-db";
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

// The listening check (D102 A, D105): after a catalog sync, both of our voices say each car model and part type of the
// shop, our own speech-to-text writes it down, and the spellings the matcher would miss, written the same way for both
// voices, are suggested to the owner (origin listening), who adds them as aliases or dismisses them: the first live
// run showed that added unseen, everyday words ("মোবাইল", "অল্প") would become names. Each name is checked once
// (speech_checks); at most 500 names per shop, a batch per run.

export const MAX_CHECKS_PER_SHOP = 500;
const PER_RUN = 60;
const VOICES = ["aditi", "arjun"] as const;
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
  /** Spellings suggested to the owner (none is used before the owner adds it, D105). */
  suggested: number;
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
  options: { limit?: number; log?: (line: string) => void } = {},
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
  const dictionary = buildDictionary([...GLOSSARY, ...aliasEntries(own)]);
  const done = new Set(checked.map((row) => `${row.concept}|${row.value}`));
  const todo = namesToCheck(catalog, dictionary).filter((name) => !done.has(`${name.concept}|${name.value}`));
  const room = Math.max(0, MAX_CHECKS_PER_SHOP - checked.length);
  const batch = todo.slice(0, Math.min(options.limit ?? PER_RUN, room));
  const result: SpeechCheckResult = { checked: 0, suggested: 0, skipped: 0, left: todo.length };
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

  const suggestedThisRun = new Set<string>();
  for (const name of batch) {
    const spoken = name.spoken ?? spellings.get(name.value);
    if (!spoken) {
      result.skipped++;
      continue; // no Bangla word yet: tried again next time
    }
    // Both voices say it; only what speech-to-text wrote the same way for both is suggested, so a one-off guess is not.
    const target = { concept: name.concept, value: name.value };
    const perVoice: { heard: string[]; keep: string[] }[] = [];
    try {
      for (const voice of VOICES) {
        const audio = await tts.synthesize(`${spoken} ${CARRIER}`, { voice });
        const asr = await stt.transcribe(audio.bytes, { keyterms: [], nbest: 5, lowConfidenceBelow: 0.5 });
        const hypotheses = asr.nbest.length ? asr.nbest.map((hypothesis) => hypothesis.text) : [asr.text];
        perVoice.push(checkedSpellings(spoken, hypotheses, dictionary, target));
      }
    } catch (error) {
      return { ...result, stopped: error instanceof Error ? error.message : String(error) };
    }
    const heard = [...new Set(perVoice.flatMap((voice) => voice.heard))];
    const both = perVoice[0]!.keep.filter((word) => perVoice.every((voice) => voice.keep.includes(word)));
    // A new host's name: its Bangla word (from the LLM) is suggested too, so a request with it can be understood.
    const ownWord = name.spoken ? null : learnableWords(spoken, dictionary);
    const words = [...new Set([...(ownWord ? [ownWord] : []), ...both])].filter(
      (word) => !suggestedThisRun.has(word), // never the same word for two names
    );
    words.forEach((word) => suggestedThisRun.add(word));
    await withAdmin(async (tx) => {
      if (words.length) {
        await tx
          .insert(aliasSuggestions)
          .values(
            words.map((word) => ({
              shopId,
              heard: word,
              targetConcept: name.concept,
              targetValue: name.value,
              origin: "listening",
            })),
          )
          .onConflictDoNothing();
      }
      await tx
        .insert(speechChecks)
        .values({
          shopId,
          targetConcept: name.concept,
          targetValue: name.value,
          spoken,
          heard,
          added: words.length,
        })
        .onConflictDoNothing();
    });
    result.checked++;
    result.suggested += words.length;
    result.left--;
    options.log?.(
      `${name.value}: said "${spoken}", heard ${JSON.stringify(heard)}, suggested ${JSON.stringify(words)}`,
    );
  }
  return result;
}
