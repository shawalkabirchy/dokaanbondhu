import { connections } from "@dokaanbondhu/platform-db";
import { eq } from "drizzle-orm";
import { clearHostCache } from "../../../../../../../src/server/host";
import { route } from "../../../../../../../src/server/route";
import { connectionView, dbConnection, introspected } from "../../../../../../../src/server/setup";
import { platform } from "../../../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /setup/connections/{id}/test (owner): connects read-only and reads the tables it can see (spec 8.3, 11.3). A
 * connection that sees at least one table becomes active; otherwise it is in error with the reason.
 */
export const POST = route<{ id: string }>({ role: "owner", limit: "setup" }, async ({ caller, params }) => {
  await dbConnection(caller.shopId, params.id);
  let result: { ok: boolean; tables?: number; error?: string };
  try {
    const tables = await introspected(caller.shopId, params.id, true);
    result = tables.length
      ? { ok: true, tables: tables.length }
      : { ok: false, tables: 0, error: "no tables are visible to this user; check its grants" };
  } catch (error) {
    result = { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
  const [row] = await platform().withShop(caller.shopId, (tx) =>
    tx
      .update(connections)
      .set({
        status: result.ok ? "active" : "error",
        lastCheckedAt: new Date(),
        lastError: result.ok ? null : (result.error ?? null),
      })
      .where(eq(connections.id, params.id))
      .returning(),
  );
  clearHostCache(caller.shopId);
  return Response.json({ ...result, connection: connectionView(row!) });
});
