import { wordDecisionSchema } from "@dokaanbondhu/contracts";
import { phoneticKey } from "@dokaanbondhu/core";
import { aliases, aliasSuggestions } from "@dokaanbondhu/platform-db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appError } from "../../../../../../src/server/errors";
import { clearHostCache } from "../../../../../../src/server/host";
import { readBody, route } from "../../../../../../src/server/route";
import { platform } from "../../../../../../src/server/singletons";
import { wordsView } from "../../../../../../src/server/words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /setup/words/{id} (owner): { action: "add" | "dismiss" } for a learned word (D102 B). Added, it becomes the
 * shop's alias (source learned) and the next turn understands it; dismissed, it is never offered again.
 */
export const PUT = route<{ id: string }>(
  { role: "owner", limit: "setup" },
  async ({ request, caller, params }) => {
    const id = z.uuid().safeParse(params.id);
    if (!id.success) throw appError("NOT_FOUND", 404, { entity: "word" });
    const { action } = await readBody(request, wordDecisionSchema);
    await platform().withShop(caller.shopId, async (tx) => {
      const [word] = await tx
        .select()
        .from(aliasSuggestions)
        .where(and(eq(aliasSuggestions.id, id.data), eq(aliasSuggestions.status, "open")));
      if (!word) throw appError("NOT_FOUND", 404, { entity: "word" });
      if (action === "add") {
        await tx.insert(aliases).values({
          shopId: caller.shopId,
          aliasText: word.heard,
          aliasNormalized: word.heard,
          aliasPhonetic: phoneticKey(word.heard),
          targetConcept: word.targetConcept,
          targetValue: word.targetValue,
          source: "learned",
        });
      }
      await tx
        .update(aliasSuggestions)
        .set({ status: action === "add" ? "added" : "dismissed" })
        .where(eq(aliasSuggestions.id, word.id));
    });
    clearHostCache(caller.shopId); // the next turn's dictionary has the word
    return Response.json({ words: await wordsView(caller.shopId) });
  },
);
