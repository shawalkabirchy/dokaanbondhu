import { actionDecisionSchema } from "@dokaanbondhu/contracts";
import { CONFIRM_TTL_MS } from "@dokaanbondhu/engine/conversation";
import { actionLogs } from "@dokaanbondhu/platform-db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appError } from "../../../../../../src/server/errors";
import { readBody, route } from "../../../../../../src/server/route";
import { platform } from "../../../../../../src/server/singletons";
import { chatTurn, loadConversation, ndjsonResponse } from "../../../../../../src/server/turns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /actions/{actionId}/decision (any): { decision: "yes" | "no", speak? } from the confirmation sheet -> the NDJSON
 * reply stream (spec 8.3, 9.9). Only the user's own pending action of the last 60 s; the decision runs as a turn of
 * its conversation, the same as saying হ্যাঁ or না (D136).
 */
export const POST = route<{ actionId: string }>(
  { role: "any", limit: "turn" },
  async ({ request, caller, params, requestId }) => {
    const body = await readBody(request, actionDecisionSchema);
    const id = z.uuid().safeParse(params.actionId);
    if (!id.success) throw appError("NOT_FOUND", 404, { entity: "action" });
    const [action] = await platform().withShop(caller.shopId, (tx) =>
      tx
        .select()
        .from(actionLogs)
        .where(and(eq(actionLogs.id, id.data), eq(actionLogs.userId, caller.userId))),
    );
    if (!action?.conversationId) throw appError("NOT_FOUND", 404, { entity: "action" });
    if (action.status !== "pending") throw appError("ACTION_NOT_PENDING", 409);
    if (action.createdAt.getTime() + CONFIRM_TTL_MS <= Date.now()) {
      await platform().withShop(caller.shopId, (tx) =>
        tx
          .update(actionLogs)
          .set({ status: "cancelled" })
          .where(and(eq(actionLogs.id, action.id), eq(actionLogs.status, "pending"))),
      );
      throw appError("ACTION_EXPIRED", 409);
    }
    const conversation = await loadConversation(caller, action.conversationId);
    if (conversation.state.action?.id !== action.id) throw appError("ACTION_NOT_PENDING", 409);
    return ndjsonResponse((emit) =>
      chatTurn(
        {
          caller,
          conversation,
          text: body.decision === "yes" ? "হ্যাঁ" : "না",
          evalMode: false,
          requestId,
          ...(body.speak !== undefined ? { speak: body.speak } : {}),
        },
        emit,
      ),
    );
  },
);
