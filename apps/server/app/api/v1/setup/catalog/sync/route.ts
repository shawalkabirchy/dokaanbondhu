import { catalogSyncSchema, type CatalogSyncResult } from "@dokaanbondhu/contracts";
import { parseAesKey } from "@dokaanbondhu/engine/crypto";
import { SchemaMapError, syncConnection } from "@dokaanbondhu/engine/host";
import { serverEnv } from "../../../../../../src/env";
import { appError } from "../../../../../../src/server/errors";
import { clearHostCache, hostPools } from "../../../../../../src/server/host";
import { readBody, route } from "../../../../../../src/server/route";
import { dbConnection } from "../../../../../../src/server/setup";
import { platform } from "../../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /setup/catalog/sync (owner): runs catalog.sync for one connection now (spec 8.3, 11.4). */
export const POST = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const body = await readBody(request, catalogSyncSchema);
  const connection = await dbConnection(caller.shopId, body.connection_id);
  let counts;
  try {
    counts = await syncConnection(
      (fn) => platform().withShop(caller.shopId, fn),
      hostPools(),
      parseAesKey(serverEnv().AES_KEY),
      caller.shopId,
      connection.id,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    if (error instanceof SchemaMapError) throw appError("VALIDATION_FAILED", 400, { reason });
    throw appError("CONNECTION_FAILED", 502, { reason });
  }
  clearHostCache(caller.shopId);
  const catalog: CatalogSyncResult = {
    parts: counts.parts,
    vehicles: counts.vehicles,
    customers: counts.customers,
    suppliers: counts.suppliers,
    synced_at: counts.syncedAt.toISOString(),
  };
  return Response.json({ catalog });
});
