import type { ActionsPage } from "@dokaanbondhu/contracts";
import { actionLogs, capabilities, users } from "@dokaanbondhu/platform-db";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { actionView } from "../../../../src/server/actions";
import { appError } from "../../../../src/server/errors";
import { shopHost } from "../../../../src/server/host";
import { route } from "../../../../src/server/route";
import { platform } from "../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = 20;
const MAX_PAGE = 50;

/** A cursor names the last row of a page: its time as the database writes it (to the microsecond) and its ID. */
const cursorOf = (createdAt: string, id: string) => Buffer.from(`${createdAt}|${id}`).toString("base64url");

function readCursor(value: string | null): { createdAt: string; id: string } | null {
  if (!value) return null;
  const [createdAt, id] = Buffer.from(value, "base64url").toString().split("|");
  if (!createdAt || Number.isNaN(Date.parse(createdAt)) || !z.uuid().safeParse(id).success)
    throw appError("VALIDATION_FAILED", 400, { field: "cursor" });
  return { createdAt, id: id! };
}

/**
 * GET /actions?cursor=&limit=&conversation_id= (any): the history, newest first (spec 8.3). Staff see their own, the
 * owner sees all; each says whether the caller may undo it now from the given conversation (D38).
 */
export const GET = route({ role: "any" }, async ({ request, caller }) => {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? PAGE) || PAGE, 1), MAX_PAGE);
  const cursor = readCursor(url.searchParams.get("cursor"));
  const raw = url.searchParams.get("conversation_id");
  const conversationId = raw && z.uuid().safeParse(raw).success ? raw : null;
  const where: SQL[] = [];
  if (caller.role !== "owner") where.push(eq(actionLogs.userId, caller.userId));
  if (cursor)
    where.push(
      sql`(${actionLogs.createdAt}, ${actionLogs.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
    );
  const rows = await platform().withShop(caller.shopId, (tx) =>
    tx
      .select({
        action: actionLogs,
        at: sql<string>`${actionLogs.createdAt}::text`,
        capability: capabilities.name,
        userName: users.name,
      })
      .from(actionLogs)
      .innerJoin(capabilities, eq(capabilities.id, actionLogs.capabilityId))
      .innerJoin(users, eq(users.id, actionLogs.userId))
      .where(and(...where))
      .orderBy(desc(actionLogs.createdAt), desc(actionLogs.id))
      .limit(limit + 1),
  );
  const { allWrites } = await shopHost(caller.shopId);
  const now = new Date();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const body: ActionsPage = {
    actions: page.map((row) =>
      actionView(
        row.action,
        {
          capability: row.capability,
          userName: row.userName,
          write: allWrites.find((write) => write.id === row.action.capabilityId),
        },
        caller,
        conversationId,
        now,
      ),
    ),
    next_cursor: rows.length > limit && last ? cursorOf(last.at, last.action.id) : null,
  };
  return Response.json(body);
});
