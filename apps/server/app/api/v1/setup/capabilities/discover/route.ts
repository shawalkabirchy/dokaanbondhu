import { discoverSchema, knownFeatures, type DiscoverResult } from "@dokaanbondhu/contracts";
import {
  capabilityViews,
  fetchOpenApi,
  HostCallFailed,
  importOpenApi,
  OpenApiImportError,
  saveImport,
} from "@dokaanbondhu/engine/host";
import { connections } from "@dokaanbondhu/platform-db";
import { eq } from "drizzle-orm";
import { appError } from "../../../../../../src/server/errors";
import { readBody, route } from "../../../../../../src/server/route";
import { apiConnectionOf, apiConnectionRow } from "../../../../../../src/server/setup";
import { platform } from "../../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /setup/capabilities/discover (owner): imports the API connection's OpenAPI document as capabilities under the
 * re-import rules (spec 11.8, D134). The detected feature list is saved while the owner has not confirmed one; once
 * confirmed, it is only shown, for the owner to compare.
 */
export const POST = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const body = await readBody(request, discoverSchema);
  const row = await apiConnectionRow(caller.shopId, body.connection_id);
  let imported;
  try {
    const { document, path } = await fetchOpenApi(await apiConnectionOf(caller.shopId, row.id));
    imported = importOpenApi(document, path);
  } catch (error) {
    if (error instanceof HostCallFailed)
      throw appError("CONNECTION_FAILED", 502, { reason: error.message.slice(0, 300) });
    if (error instanceof OpenApiImportError)
      throw appError("HOST_ERROR", 502, { reason: error.message.slice(0, 300) });
    throw error;
  }
  const detected = knownFeatures(imported.features);
  const result: DiscoverResult = await platform().withShop(caller.shopId, async (tx) => {
    const summary = await saveImport(tx, caller.shopId, row.id, imported);
    if (!row.featuresConfirmedAt) {
      await tx.update(connections).set({ features: detected }).where(eq(connections.id, row.id));
    }
    return {
      connection_id: row.id,
      ...summary,
      detected_features: detected,
      features_confirmed: Boolean(row.featuresConfirmedAt),
      capabilities: await capabilityViews(tx, { connectionId: row.id }),
    };
  });
  return Response.json(result);
});
