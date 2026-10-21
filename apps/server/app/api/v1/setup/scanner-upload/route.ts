import { randomUUID } from "node:crypto";
import { scannerSummarySchema, type ScannerUploadResult } from "@dokaanbondhu/contracts";
import { AppError } from "@dokaanbondhu/core";
import { describeRoutes, importScannerSummary, saveImport } from "@dokaanbondhu/engine/host";
import { connections, setupTokenHash, SetupTokenError } from "@dokaanbondhu/platform-db";
import { and, asc, eq, ne } from "drizzle-orm";
import { appError, errorResponse } from "../../../../../src/server/errors";
import { clearHostCache } from "../../../../../src/server/host";
import { readBody } from "../../../../../src/server/route";
import { shopLlm } from "../../../../../src/server/shop";
import { logger, platform } from "../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /setup/scanner-upload (spec 8.3, 11.8, 16.3): the Laravel scanner's summary, with the owner's one-time setup
 * token in X-Setup-Token instead of a login. Its routes become capabilities of the shop's API connection through the
 * OpenAPI importer (source scanner), under the re-import rules; then one LLM call per write route writes its
 * description. A refused upload (no API connection yet) leaves the token unused, so it can be sent again.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    const token = request.headers.get("x-setup-token") ?? "";
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw appError("SETUP_TOKEN_INVALID", 401);
    const summary = await readBody(request, scannerSummarySchema);
    const imported = importScannerSummary(summary);
    const saved = await platform().withSetupToken(setupTokenHash(token), async (tx, row) => {
      if (row.purpose !== "scanner_upload") throw new SetupTokenError("unknown");
      const [api] = await tx
        .select({ id: connections.id })
        .from(connections)
        .where(and(eq(connections.kind, "api"), ne(connections.status, "disabled")))
        .orderBy(asc(connections.createdAt))
        .limit(1);
      if (!api) throw appError("NOT_FOUND", 404, { entity: "connection" });
      return {
        shopId: row.shopId,
        connectionId: api.id,
        ...(await saveImport(tx, row.shopId, api.id, imported, "scanner")),
      };
    });
    const descriptions = await describeRoutes(summary, await shopLlm(saved.shopId)).catch(
      () => new Map<string, string>(),
    );
    if (descriptions.size) {
      await platform().withShop(saved.shopId, (tx) =>
        saveImport(
          tx,
          saved.shopId,
          saved.connectionId,
          importScannerSummary(summary, descriptions),
          "scanner",
        ),
      );
    }
    clearHostCache(saved.shopId); // the turn's tools come from these capabilities
    const result: ScannerUploadResult = {
      connection_id: saved.connectionId,
      added: saved.added,
      changed: saved.changed,
      kept: saved.kept,
      removed: saved.removed,
      unresolved: saved.unresolved,
      described: descriptions.size,
    };
    return Response.json(result);
  } catch (error) {
    if (error instanceof SetupTokenError)
      return errorResponse(appError("SETUP_TOKEN_INVALID", 401, { reason: error.reason }), requestId);
    if (!(error instanceof AppError))
      logger().error({ err: error, request_id: requestId, path: "/setup/scanner-upload" }, "request failed");
    return errorResponse(error, requestId);
  }
}
