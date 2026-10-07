import type { ConnectionTest } from "@dokaanbondhu/contracts";
import { checkApiConnection } from "@dokaanbondhu/engine/host";
import { connections } from "@dokaanbondhu/platform-db";
import { eq } from "drizzle-orm";
import { appError } from "../../../../../../../src/server/errors";
import { clearHostCache } from "../../../../../../../src/server/host";
import { route } from "../../../../../../../src/server/route";
import { apiConnectionOf, connectionView, introspected } from "../../../../../../../src/server/setup";
import { platform } from "../../../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /setup/connections/{id}/test (owner, spec 8.3). A database connection connects read-only and reads the tables
 * it can see (spec 11.3); one that sees at least one table becomes active. An API connection reads the host's OpenAPI
 * document and makes one harmless guarded read to see that the secret is accepted (spec 11.12, D134); an API key's
 * header left empty is taken from the document. Otherwise the connection is in error with the reason.
 */
export const POST = route<{ id: string }>({ role: "owner", limit: "setup" }, async ({ caller, params }) => {
  const [connection] = await platform().withShop(caller.shopId, (tx) =>
    tx.select({ kind: connections.kind }).from(connections).where(eq(connections.id, params.id)),
  );
  if (!connection) throw appError("NOT_FOUND", 404, { entity: "connection" });

  let result: Omit<ConnectionTest, "connection">;
  let authHeader: string | undefined;
  if (connection.kind === "api") {
    const check = await checkApiConnection(await apiConnectionOf(caller.shopId, params.id));
    authHeader = check.authHeader;
    result = {
      ok: check.ok,
      ...(check.operations === undefined ? {} : { operations: check.operations }),
      ...(check.key ? { key: check.key } : {}),
      ...(check.error ? { error: check.error } : {}),
    };
  } else {
    try {
      const tables = await introspected(caller.shopId, params.id, true);
      result = tables.length
        ? { ok: true, tables: tables.length }
        : { ok: false, tables: 0, error: "no tables are visible to this user; check its grants" };
    } catch (error) {
      result = { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    }
  }
  const [row] = await platform().withShop(caller.shopId, (tx) =>
    tx
      .update(connections)
      .set({
        status: result.ok ? "active" : "error",
        lastCheckedAt: new Date(),
        lastError: result.ok ? null : (result.error ?? null),
        ...(authHeader ? { authHeader } : {}),
      })
      .where(eq(connections.id, params.id))
      .returning(),
  );
  clearHostCache(caller.shopId);
  return Response.json({ ...result, connection: connectionView(row!) });
});
