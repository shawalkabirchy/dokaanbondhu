import { z } from "zod";
import { ERROR_CODES } from "./errors";

// The reply stream (spec 8.5, Appendix A): one JSON object per line. The app parses every line with these schemas
// and ignores event types it does not know, so a newer server never breaks an older app.

const state = z.enum([
  "IDLE",
  "LISTENING",
  "UNDERSTANDING",
  "CLARIFYING",
  "CONFIRMING",
  "EXECUTING",
  "RESPONDING",
]);

export const replyEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), state, label_key: z.string() }),
  z.object({ type: z.literal("transcript"), text: z.string(), unclear: z.array(z.string()).default([]) }),
  z.object({
    type: z.literal("text"),
    seq: z.number().int().nonnegative(),
    text: z.string(),
    final: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("audio"),
    seq: z.number().int().nonnegative(),
    mime: z.literal("audio/mpeg"),
    data: z.string(),
  }),
  z.object({
    type: z.literal("cards"),
    parts: z.array(
      z.object({
        host_part_id: z.string(),
        name: z.string(),
        name_bn: z.string().nullable().optional(),
        quality: z.string().nullable().optional(),
        position: z.string().nullable().optional(),
        unit: z.string().nullable().optional(),
        stock: z.number().nullable(),
        price_paisa: z.record(z.string(), z.number()),
        rack: z.string().nullable(),
        fitment_verified: z.boolean(),
        photo_url: z.string().nullable().optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal("table"),
    title: z.string(),
    columns: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        kind: z.enum(["text", "money", "count", "number", "date"]),
      }),
    ),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))), // money cells in paisa
    truncated: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("choices"),
    slot: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string(), sublabel: z.string().optional() })),
  }),
  z.object({
    type: z.literal("confirm"),
    action_id: z.uuid(),
    text: z.string(),
    fields: z.array(
      z.object({ label: z.string(), value: z.string(), highlight: z.boolean().default(false) }),
    ),
    warnings: z.array(z.string()).default([]),
    expires_at: z.string(),
  }),
  z.object({
    type: z.literal("action_result"),
    action_id: z.uuid(),
    status: z.enum(["done", "failed", "review", "cancelled"]),
    undo_available: z.boolean(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.enum(ERROR_CODES),
    message_key: z.string(),
    fatal: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("done"),
    turn_id: z.string(),
    state,
    timings_ms: z.record(z.string(), z.number()).default({}),
    trace: z.unknown().optional(), // only in evaluation mode
  }),
]);
export type ReplyEvent = z.infer<typeof replyEventSchema>;

/** One parsed line: the event, or null for a type this app does not know (or a line that does not match). */
export function parseReplyEvent(value: unknown): ReplyEvent | null {
  const result = replyEventSchema.safeParse(value);
  return result.success ? result.data : null;
}
