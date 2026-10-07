import { conversations } from "@dokaanbondhu/platform-db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { appError } from "../../../../../../../src/server/errors";
import { route } from "../../../../../../../src/server/route";
import { platform } from "../../../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const keySchema = z.enum(["vehicle", "customer"]);

/**
 * DELETE /conversations/{conversationId}/context/{key} (any): forgets the remembered car or customer of the caller's
 * own conversation, from the app's memory line (spec 8.3, 9.8, D125, D126); 204. An open question keeps its own
 * details; someone else's conversation is not found.
 */
export const DELETE = route<{ conversationId: string; key: string }>(
  { role: "any" },
  async ({ caller, params }) => {
    const key = keySchema.safeParse(params.key);
    if (!key.success) throw appError("NOT_FOUND", 404, { entity: "context" });
    if (!z.uuid().safeParse(params.conversationId).success) throw appError("CONVERSATION_NOT_FOUND", 404);
    const forgotten = await platform().withShop(caller.shopId, (tx) =>
      tx
        .update(conversations)
        .set({ context: sql`${conversations.context} - ${key.data}::text` })
        .where(and(eq(conversations.id, params.conversationId), eq(conversations.userId, caller.userId)))
        .returning({ id: conversations.id }),
    );
    if (!forgotten.length) throw appError("CONVERSATION_NOT_FOUND", 404);
    return new Response(null, { status: 204 });
  },
);
