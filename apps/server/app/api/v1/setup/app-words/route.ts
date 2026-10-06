import { appWordDecisionSchema, type AppWordsView } from "@dokaanbondhu/contracts";
import { APP_WORD_CONCEPTS } from "@dokaanbondhu/core";
import { appWordsOf, loadCatalog, type AppWords } from "@dokaanbondhu/engine/host";
import { connections } from "@dokaanbondhu/platform-db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { appError } from "../../../../../src/server/errors";
import { clearHostCache } from "../../../../../src/server/host";
import { readBody, route } from "../../../../../src/server/route";
import { dbConnection } from "../../../../../src/server/setup";
import { platform } from "../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The app's own words (D121, D122): from the last catalog sync, every value the app writes for a customer's price
// level and a part's quality, position and unit, with ours from the word list or the owner. A value nobody has named
// is retail (price) or never matched (the rest) until the owner chooses ours.

async function view(shopId: string, connectionId: string): Promise<AppWordsView> {
  const connection = await dbConnection(shopId, connectionId);
  const catalog = await platform().withShop(shopId, (tx) => loadCatalog(tx, connectionId));
  const chosen = connection.appWords as AppWords;
  const groups = Object.fromEntries(
    APP_WORD_CONCEPTS.map((concept) => [
      concept,
      appWordsOf(catalog, concept, chosen).map((word) => ({
        value: word.value,
        count: word.count,
        our: word.our,
        decided_by: word.decidedBy,
      })),
    ]),
  ) as AppWordsView["groups"];
  return { connection_id: connectionId, groups };
}

/** GET /setup/app-words?connection_id= (owner). */
export const GET = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const id = z.uuid().safeParse(new URL(request.url).searchParams.get("connection_id"));
  if (!id.success) throw appError("VALIDATION_FAILED", 400, { field: "connection_id" });
  return Response.json({ words: await view(caller.shopId, id.data) });
});

/** PUT /setup/app-words (owner): { connection_id, concept, value, our } sets ours for one of the app's words. */
export const PUT = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const body = await readBody(request, appWordDecisionSchema);
  const connection = await dbConnection(caller.shopId, body.connection_id);
  const choice = JSON.stringify({ [body.value]: body.our });
  await platform().withShop(caller.shopId, (tx) =>
    tx
      .update(connections)
      .set({
        appWords: sql`jsonb_set(${connections.appWords}, ${`{${body.concept}}`}::text[], coalesce(${connections.appWords} -> ${body.concept}::text, '{}'::jsonb) || ${choice}::jsonb)`,
      })
      .where(eq(connections.id, connection.id)),
  );
  clearHostCache(caller.shopId); // the next turn reads the word the owner's way
  return Response.json({ words: await view(caller.shopId, connection.id) });
});
