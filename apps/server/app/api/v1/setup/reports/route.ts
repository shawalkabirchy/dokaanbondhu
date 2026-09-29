import { reportConfirmSchema, type ReportsView } from "@dokaanbondhu/contracts";
import {
  loadSchemaMap,
  proposeStockValue,
  stockValue,
  type Dialect,
  type SchemaMap,
} from "@dokaanbondhu/engine/host";
import { reportFormulas } from "@dokaanbondhu/platform-db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appError } from "../../../../../src/server/errors";
import { clearHostCache, hostPools } from "../../../../../src/server/host";
import { readBody, route } from "../../../../../src/server/route";
import { dbConnection, hostDbOf } from "../../../../../src/server/setup";
import { platform } from "../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Report formulas (spec 11.7): this semester only the stock value has one. Setup proposes it when both fields are
// mapped and confirmed, shows its current result, and the owner confirms it once; profit and cash book stay "see this
// in your app".

async function view(shopId: string, connectionId: string): Promise<ReportsView> {
  const connection = await dbConnection(shopId, connectionId);
  const { map, stored } = await platform().withShop(shopId, async (tx) => ({
    map: await loadSchemaMap(tx, connectionId, connection.dialect as Dialect),
    stored: await tx
      .select()
      .from(reportFormulas)
      .where(and(eq(reportFormulas.connectionId, connectionId), eq(reportFormulas.name, "stock_value"))),
  }));
  const proposed = proposeStockValue(map);
  let current: bigint | null = null;
  if (proposed) {
    try {
      const db = await hostDbOf(shopId, connectionId);
      current = await stockValue(map, (query) => hostPools().readOnly(db, (run) => run(query)));
    } catch {
      current = null; // the host did not answer: shown as unknown, the formula can still be confirmed later
    }
  }
  return {
    connection_id: connectionId,
    stock_value: {
      available: proposed !== null,
      confirmed: Boolean(stored[0]?.confirmedAt),
      current_taka: current === null ? null : Number(current),
    },
    see_in_app: ["profit_loss", "cash_book"],
  };
}

/** GET /setup/reports?connection_id= (owner). */
export const GET = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const id = z.uuid().safeParse(new URL(request.url).searchParams.get("connection_id"));
  if (!id.success) throw appError("VALIDATION_FAILED", 400, { field: "connection_id" });
  return Response.json({ reports: await view(caller.shopId, id.data) });
});

/** PUT /setup/reports (owner): { connection_id, name: "stock_value" } confirms the proposed formula. */
export const PUT = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const body = await readBody(request, reportConfirmSchema);
  const connection = await dbConnection(caller.shopId, body.connection_id);
  const map: SchemaMap = await platform().withShop(caller.shopId, (tx) =>
    loadSchemaMap(tx, connection.id, connection.dialect as Dialect),
  );
  const proposed = proposeStockValue(map);
  if (!proposed)
    throw appError("VALIDATION_FAILED", 400, { reason: "confirm StockItem.quantity and Price.cost first" });
  const now = new Date();
  await platform().withShop(caller.shopId, (tx) =>
    tx
      .insert(reportFormulas)
      .values({
        shopId: caller.shopId,
        connectionId: connection.id,
        name: proposed.name,
        definition: proposed.definition,
        confirmedAt: now,
        confirmedBy: caller.userId,
      })
      .onConflictDoUpdate({
        target: [reportFormulas.connectionId, reportFormulas.name],
        set: { definition: proposed.definition, confirmedAt: now, confirmedBy: caller.userId },
      }),
  );
  clearHostCache(caller.shopId);
  return Response.json({ reports: await view(caller.shopId, connection.id) });
});
