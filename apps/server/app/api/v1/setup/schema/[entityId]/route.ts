import { entityConfirmSchema } from "@dokaanbondhu/contracts";
import {
  checkProposal,
  confirmEntity,
  loadSchemaMap,
  proposalSchema,
  type Concept,
  type Dialect,
  type EntityMap,
} from "@dokaanbondhu/engine/host";
import { schemaEntities } from "@dokaanbondhu/platform-db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { appError } from "../../../../../../src/server/errors";
import { clearHostCache } from "../../../../../../src/server/host";
import { readBody, route } from "../../../../../../src/server/route";
import { dbConnection, introspected, schemaView } from "../../../../../../src/server/setup";
import { platform } from "../../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /setup/schema/{entityId} (owner): confirms one concept as proposed, or as corrected; a correction is checked
 * against the host's tables like a proposal, so only real tables and columns are ever confirmed (spec 11.3).
 */
export const PUT = route<{ entityId: string }>(
  { role: "owner", limit: "setup" },
  async ({ request, caller, params }) => {
    const body = await readBody(request, entityConfirmSchema);
    if (!z.uuid().safeParse(params.entityId).success) throw appError("NOT_FOUND", 404, { entity: "schema" });
    const [row] = await platform().withShop(caller.shopId, (tx) =>
      tx.select().from(schemaEntities).where(eq(schemaEntities.id, params.entityId)),
    );
    if (!row) throw appError("NOT_FOUND", 404, { entity: "schema" });
    const connection = await dbConnection(caller.shopId, row.connectionId);
    let entity: EntityMap | undefined;
    let warnings: string[] = [];
    if (body.entity) {
      let tables;
      try {
        tables = await introspected(caller.shopId, connection.id);
      } catch (error) {
        throw appError("CONNECTION_FAILED", 502, {
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
      const checked = checkProposal(
        proposalSchema.parse({ entities: [{ concept: row.concept, ...body.entity }] }),
        tables,
      );
      entity = checked.entities[0];
      warnings = checked.warnings;
    } else {
      const map = await platform().withShop(caller.shopId, (tx) =>
        loadSchemaMap(tx, connection.id, connection.dialect as Dialect),
      );
      entity = map.entities[row.concept as Concept];
    }
    if (!entity) throw appError("VALIDATION_FAILED", 400, { warnings });
    const confirmed = entity;
    await platform().withShop(caller.shopId, (tx) =>
      confirmEntity(tx, caller.shopId, connection.id, confirmed, caller.userId),
    );
    clearHostCache(caller.shopId);
    return Response.json({ schema: await schemaView(caller.shopId, connection.id, warnings) });
  },
);
