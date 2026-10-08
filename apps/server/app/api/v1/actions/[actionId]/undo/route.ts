import { randomUUID } from "node:crypto";
import { actionUndoSchema, type ReplyEvent } from "@dokaanbondhu/contracts";
import { resultText, splitSentences } from "@dokaanbondhu/core";
import { mayUndo, undoAction, type ActionPreview, type Undo } from "@dokaanbondhu/engine/write";
import { actionLogs, users } from "@dokaanbondhu/platform-db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { undoable } from "../../../../../../src/server/actions";
import { appError } from "../../../../../../src/server/errors";
import { shopHost } from "../../../../../../src/server/host";
import { readBody, route } from "../../../../../../src/server/route";
import { logger, platform } from "../../../../../../src/server/singletons";
import { ndjsonResponse } from "../../../../../../src/server/turns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /actions/{actionId}/undo (any): { conversation_id? } -> the NDJSON reply stream (spec 8.3, 11.9.1). The owner
 * may undo any action; staff only their own, from the conversation it was made in, within 10 minutes (D38). The
 * action is claimed first, so two taps undo it once; the undo is its own action_logs row with undo_of.
 */
export const POST = route<{ actionId: string }>(
  { role: "any", limit: "turn" },
  async ({ request, caller, params, requestId }) => {
    const body = await readBody(request, actionUndoSchema);
    const id = z.uuid().safeParse(params.actionId);
    if (!id.success) throw appError("NOT_FOUND", 404, { entity: "action" });
    const [row] = await platform().withShop(caller.shopId, (tx) =>
      tx.select().from(actionLogs).where(eq(actionLogs.id, id.data)),
    );
    if (!row) throw appError("NOT_FOUND", 404, { entity: "action" });
    const { allWrites, host } = await shopHost(caller.shopId);
    const capability = allWrites.find((write) => write.id === row.capabilityId);
    if (!undoable(row, capability) || !host.writes || row.undoneAt) throw appError("UNDO_NOT_AVAILABLE", 409);
    const now = new Date();
    const allowed = mayUndo({
      role: caller.role,
      userId: caller.userId,
      conversationId: body.conversation_id ?? null,
      now,
      action: { userId: row.userId, conversationId: row.conversationId, doneAt: row.doneAt },
    });
    if (!allowed) throw appError("UNDO_NOT_ALLOWED", 403);
    const [claimed] = await platform().withShop(caller.shopId, (tx) =>
      tx
        .update(actionLogs)
        .set({ undoneAt: now })
        .where(
          and(
            eq(actionLogs.id, row.id),
            isNull(actionLogs.undoneAt),
            inArray(actionLogs.status, ["done", "review"]),
          ),
        )
        .returning({ id: actionLogs.id }),
    );
    if (!claimed) throw appError("UNDO_NOT_AVAILABLE", 409);
    const [user] = await platform().withShop(caller.shopId, (tx) =>
      tx.select({ name: users.name }).from(users).where(eq(users.id, caller.userId)),
    );
    const preview = row.preview as ActionPreview;
    const writes = host.writes;

    return ndjsonResponse(async (emit: (event: ReplyEvent) => void) => {
      emit({ type: "status", state: "EXECUTING", label_key: "status.saving" });
      const undoId = randomUUID();
      const idempotencyKey = randomUUID();
      let undone: Undo | null = null;
      try {
        undone = await undoAction({
          capability: capability!,
          done: { response: row.response, preview },
          host: writes,
          actingUser: user?.name ?? "",
          idempotencyKey,
        });
      } catch (error) {
        logger().error({ err: error, request_id: requestId, action_id: row.id }, "undo failed");
      }
      const ok = undone?.status === "undone";
      await platform().withShop(caller.shopId, async (tx) => {
        await tx.insert(actionLogs).values({
          id: undoId,
          shopId: caller.shopId,
          userId: caller.userId,
          conversationId: body.conversation_id ?? row.conversationId,
          capabilityId: capability!.compensation!.capabilityId,
          request: undone?.request ?? null,
          response: undone?.response ?? null,
          status: ok ? "done" : "failed",
          idempotencyKey,
          undoOf: row.id,
          confirmedAt: now,
          doneAt: new Date(),
        });
        // A failed undo gives the action back, so it can be tried again.
        await tx
          .update(actionLogs)
          .set(ok ? { status: "undone" } : { undoneAt: null })
          .where(eq(actionLogs.id, row.id));
      });
      const text = undone?.text ?? resultText("failed", preview.template, { reason: "অ্যাপ সাড়া দেয়নি।" });
      const sentences = splitSentences(text);
      sentences.forEach((sentence, seq) =>
        emit({ type: "text", seq, text: sentence, final: seq === sentences.length - 1 }),
      );
      emit({
        type: "action_result",
        action_id: undoId,
        status: ok ? "done" : "failed",
        undo_available: false,
      });
      emit({
        type: "done",
        turn_id: undoId,
        state: "IDLE",
        timings_ms: { total: Date.now() - now.getTime() },
      });
    });
  },
);
