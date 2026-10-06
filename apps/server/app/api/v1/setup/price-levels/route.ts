import { priceLevelDecisionSchema, type PriceLevelsView } from "@dokaanbondhu/contracts";
import { loadCatalog, priceLevels } from "@dokaanbondhu/engine/host";
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

// Price levels (D121): the customers' price tier or type values from the last catalog sync, each with the level the
// word list or the owner gave it. A value nobody has named is answered at retail until the owner chooses its level.

async function view(shopId: string, connectionId: string): Promise<PriceLevelsView> {
  const connection = await dbConnection(shopId, connectionId);
  const catalog = await platform().withShop(shopId, (tx) => loadCatalog(tx, connectionId));
  const levels = priceLevels(catalog, connection.priceTiers as Record<string, string>);
  return {
    connection_id: connectionId,
    levels: levels.map((level) => ({
      value: level.value,
      customers: level.customers,
      tier: level.tier,
      decided_by: level.decidedBy,
    })),
  };
}

/** GET /setup/price-levels?connection_id= (owner). */
export const GET = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const id = z.uuid().safeParse(new URL(request.url).searchParams.get("connection_id"));
  if (!id.success) throw appError("VALIDATION_FAILED", 400, { field: "connection_id" });
  return Response.json({ prices: await view(caller.shopId, id.data) });
});

/** PUT /setup/price-levels (owner): { connection_id, value, tier } sets the level of one customer value. */
export const PUT = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const body = await readBody(request, priceLevelDecisionSchema);
  const connection = await dbConnection(caller.shopId, body.connection_id);
  await platform().withShop(caller.shopId, (tx) =>
    tx
      .update(connections)
      .set({
        priceTiers: sql`${connections.priceTiers} || ${JSON.stringify({ [body.value]: body.tier })}::jsonb`,
      })
      .where(eq(connections.id, connection.id)),
  );
  clearHostCache(caller.shopId); // the next turn prices that customer's parts at the new level
  return Response.json({ prices: await view(caller.shopId, connection.id) });
});
