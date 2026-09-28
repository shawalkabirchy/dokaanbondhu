import { schemaProposeSchema } from "@dokaanbondhu/contracts";
import { AppError } from "@dokaanbondhu/core";
import { proposeSchemaMap, saveProposal, type Proposal } from "@dokaanbondhu/engine/host";
import { appError } from "../../../../../../src/server/errors";
import { clearHostCache } from "../../../../../../src/server/host";
import { readBody, route } from "../../../../../../src/server/route";
import { dbConnection, introspected, schemaView } from "../../../../../../src/server/setup";
import { shopLlm } from "../../../../../../src/server/shop";
import { platform } from "../../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /setup/schema/propose (owner): introspect, then one LLM call proposes the schema map (spec 11.3). Concepts the
 * owner already confirmed are kept. The call may take up to 180 s.
 */
export const POST = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const body = await readBody(request, schemaProposeSchema);
  const connection = await dbConnection(caller.shopId, body.connection_id);
  if (connection.status !== "active")
    throw appError("CONNECTION_FAILED", 502, { reason: "test the connection first" });
  let tables;
  try {
    tables = await introspected(caller.shopId, connection.id, true);
  } catch (error) {
    throw appError("CONNECTION_FAILED", 502, { reason: error instanceof Error ? error.message : "unknown" });
  }
  let proposal: Proposal;
  try {
    proposal = await proposeSchemaMap(await shopLlm(caller.shopId), tables);
  } catch (error) {
    if (error instanceof AppError) throw error; // no LLM answered: ASSISTANT_UNAVAILABLE
    throw appError("ASSISTANT_UNAVAILABLE", 503, { reason: "the proposal did not validate twice" });
  }
  await platform().withShop(caller.shopId, (tx) => saveProposal(tx, caller.shopId, connection.id, proposal));
  clearHostCache(caller.shopId);
  return Response.json({ schema: await schemaView(caller.shopId, connection.id, proposal.warnings) });
});
