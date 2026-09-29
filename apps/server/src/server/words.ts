import type { WordsView } from "@dokaanbondhu/contracts";
import { aliases, aliasSuggestions, speechChecks } from "@dokaanbondhu/platform-db";
import { and, count, desc, eq, gte } from "drizzle-orm";
import { platform } from "./singletons";

// Words the assistant learned (spec 8.3, D102): the suggestions from answered questions seen at least twice and not
// decided yet, and what the listening check has done for the shop.

export const SEEN_TO_SUGGEST = 2;

export async function wordsView(shopId: string): Promise<WordsView> {
  return platform().withShop(shopId, async (tx) => {
    const open = await tx
      .select()
      .from(aliasSuggestions)
      .where(and(eq(aliasSuggestions.status, "open"), gte(aliasSuggestions.seen, SEEN_TO_SUGGEST)))
      .orderBy(desc(aliasSuggestions.seen), desc(aliasSuggestions.lastSeenAt));
    const [names] = await tx.select({ n: count() }).from(speechChecks);
    const [words] = await tx.select({ n: count() }).from(aliases).where(eq(aliases.source, "asr_check"));
    return {
      suggestions: open.map((row) => ({
        id: row.id,
        heard: row.heard,
        concept: row.targetConcept as WordsView["suggestions"][number]["concept"],
        value: row.targetValue,
        seen: row.seen,
      })),
      checked: { names: names?.n ?? 0, words: words?.n ?? 0 },
    };
  });
}
