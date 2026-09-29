import type { WordsView } from "@dokaanbondhu/contracts";
import { aliasSuggestions, speechChecks } from "@dokaanbondhu/platform-db";
import { and, count, desc, eq, gte, or } from "drizzle-orm";
import { platform } from "./singletons";

// Words the assistant learned (spec 8.3, D102, D105), not decided yet: the listening check's suggestions at once, and
// the words learned from answered questions once seen twice; and what the listening check has done for the shop.

export const SEEN_TO_SUGGEST = 2;

export async function wordsView(shopId: string): Promise<WordsView> {
  return platform().withShop(shopId, async (tx) => {
    const open = await tx
      .select()
      .from(aliasSuggestions)
      .where(
        and(
          eq(aliasSuggestions.status, "open"),
          or(eq(aliasSuggestions.origin, "listening"), gte(aliasSuggestions.seen, SEEN_TO_SUGGEST)),
        ),
      )
      .orderBy(desc(aliasSuggestions.seen), desc(aliasSuggestions.lastSeenAt));
    const [names] = await tx.select({ n: count() }).from(speechChecks);
    const [found] = await tx
      .select({ n: count() })
      .from(aliasSuggestions)
      .where(eq(aliasSuggestions.origin, "listening"));
    return {
      suggestions: open.map((row) => ({
        id: row.id,
        heard: row.heard,
        concept: row.targetConcept as WordsView["suggestions"][number]["concept"],
        value: row.targetValue,
        origin: row.origin as WordsView["suggestions"][number]["origin"],
        seen: row.seen,
      })),
      checked: { names: names?.n ?? 0, words: found?.n ?? 0 },
    };
  });
}
