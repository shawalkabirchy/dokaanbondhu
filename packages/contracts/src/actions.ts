import { z } from "zod";

// Actions (spec 8.3, 9.9): the decision from the confirmation sheet's buttons. The reply is the NDJSON stream of a
// turn, as if the user had said yes or no.

export const actionDecisionSchema = z
  .object({
    decision: z.enum(["yes", "no"]),
    /** As on the chat page: the reply is also spoken (D88). */
    speak: z.boolean().optional(),
  })
  .strict();
export type ActionDecision = z.infer<typeof actionDecisionSchema>;

/** One action in the history (spec 8.3, 15.2): what the confirmation said, and what became of it. */
export const actionViewSchema = z.object({
  id: z.uuid(),
  capability: z.string(),
  template: z.string(),
  /** The confirmation as it was said. */
  text: z.string(),
  fields: z.array(z.object({ label: z.string(), value: z.string(), highlight: z.boolean() })),
  status: z.enum(["pending", "done", "failed", "review", "cancelled", "undone"]),
  verify_status: z.enum(["ok", "mismatch", "skipped"]).nullable(),
  user_name: z.string(),
  conversation_id: z.uuid().nullable(),
  created_at: z.string(),
  done_at: z.string().nullable(),
  undone_at: z.string().nullable(),
  /** This row is the undo of that action. */
  undo_of: z.uuid().nullable(),
  /** The caller may undo it now (spec 11.9.1, D38). */
  undo_available: z.boolean(),
});
export type ActionView = z.infer<typeof actionViewSchema>;

export const actionsPageSchema = z.object({
  actions: z.array(actionViewSchema),
  /** For the next page, or null at the end. */
  next_cursor: z.string().nullable(),
});
export type ActionsPage = z.infer<typeof actionsPageSchema>;

/** POST /actions/{id}/undo: staff undo only from the conversation the action was made in (D38). */
export const actionUndoSchema = z.object({ conversation_id: z.uuid().optional() }).strict();
export type ActionUndo = z.infer<typeof actionUndoSchema>;
