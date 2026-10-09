import { paikariPriceChoiceSchema, type PaikariPriceView } from "@dokaanbondhu/contracts";
import {
  chosenPaikari,
  loadCatalog,
  loadSchemaMap,
  paikariOptions,
  type Dialect,
  type PaikariOption,
} from "@dokaanbondhu/engine/host";
import { connections } from "@dokaanbondhu/platform-db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { appError } from "../../../../../src/server/errors";
import { clearHostCache, hostPools } from "../../../../../src/server/host";
import { readBody, route } from "../../../../../src/server/route";
import { dbConnection, hostDbOf } from "../../../../../src/server/setup";
import { platform } from "../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Which of the app's trade prices is paikari (D143, D146): the map's garage and wholesale price columns, each with one
// part's price as an example. The app asks only when there are two; until the owner chooses, the garage price is
// paikari, else the wholesale price.

async function view(shopId: string, connectionId: string): Promise<PaikariPriceView> {
  const connection = await dbConnection(shopId, connectionId);
  const { map, catalog } = await platform().withShop(shopId, async (tx) => ({
    map: await loadSchemaMap(tx, connectionId, connection.dialect as Dialect),
    catalog: await loadCatalog(tx, connectionId),
  }));
  let options: PaikariOption[];
  try {
    const db = await hostDbOf(shopId, connectionId);
    options = await paikariOptions(map, (query) => hostPools().readOnly(db, (run) => run(query)), catalog);
  } catch {
    options = await paikariOptions(map, null, catalog); // the app did not answer: the columns without examples
  }
  return {
    connection_id: connectionId,
    options,
    chosen: options.length > 1 ? chosenPaikari(map, connection.paikariPrice) : null,
  };
}

/** GET /setup/paikari-price?connection_id= (owner). */
export const GET = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const id = z.uuid().safeParse(new URL(request.url).searchParams.get("connection_id"));
  if (!id.success) throw appError("VALIDATION_FAILED", 400, { field: "connection_id" });
  return Response.json({ paikari: await view(caller.shopId, id.data) });
});

/** PUT /setup/paikari-price (owner): { connection_id, field } chooses one of the map's two trade prices. */
export const PUT = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const body = await readBody(request, paikariPriceChoiceSchema);
  const connection = await dbConnection(caller.shopId, body.connection_id);
  const map = await platform().withShop(caller.shopId, (tx) =>
    loadSchemaMap(tx, connection.id, connection.dialect as Dialect),
  );
  if (!chosenPaikari(map, body.field)) throw appError("VALIDATION_FAILED", 400, { field: "field" });
  await platform().withShop(caller.shopId, (tx) =>
    tx.update(connections).set({ paikariPrice: body.field }).where(eq(connections.id, connection.id)),
  );
  clearHostCache(caller.shopId); // the next answer says the chosen price
  return Response.json({ paikari: await view(caller.shopId, connection.id) });
});
