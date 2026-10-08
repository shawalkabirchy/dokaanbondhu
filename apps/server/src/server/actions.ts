import type { ActionView } from "@dokaanbondhu/contracts";
import { mayUndo, readPath, type ActionPreview, type WriteCapability } from "@dokaanbondhu/engine/write";
import type { actionLogs } from "@dokaanbondhu/platform-db";
import type { Caller } from "./route";

// Actions as the history shows them (spec 8.3, 15.2): what the confirmation said, its outcome, and whether the caller
// may undo it now (spec 11.9.1, D38).

type ActionRow = typeof actionLogs.$inferSelect;

/** Whether the action can be undone at all: it was saved, has a compensation, and the host's answer names its ID. */
export function undoable(row: ActionRow, capability: WriteCapability | undefined): boolean {
  const compensation = capability?.compensation;
  return (
    (row.status === "done" || row.status === "review") &&
    row.undoOf === null &&
    compensation !== undefined &&
    compensation !== null &&
    readPath(row.response, compensation.idFrom) != null
  );
}

export function actionView(
  row: ActionRow,
  extra: { capability: string; userName: string; write: WriteCapability | undefined },
  caller: Caller,
  conversationId: string | null,
  now: Date,
): ActionView {
  const preview = row.preview as ActionPreview | null;
  return {
    id: row.id,
    capability: extra.capability,
    template: preview?.template ?? "generic",
    text: preview?.text ?? "",
    fields: preview?.fields ?? [],
    status: row.status as ActionView["status"],
    verify_status: row.verifyStatus as ActionView["verify_status"],
    user_name: extra.userName,
    conversation_id: row.conversationId,
    created_at: row.createdAt.toISOString(),
    done_at: row.doneAt?.toISOString() ?? null,
    undone_at: row.undoneAt?.toISOString() ?? null,
    undo_of: row.undoOf,
    undo_available:
      undoable(row, extra.write) &&
      mayUndo({
        role: caller.role,
        userId: caller.userId,
        conversationId,
        now,
        action: { userId: row.userId, conversationId: row.conversationId, doneAt: row.doneAt },
      }),
  };
}
