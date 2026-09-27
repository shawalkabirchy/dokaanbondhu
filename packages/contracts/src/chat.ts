import { z } from "zod";

// Conversations and chat messages (spec 8.3). The reply to a message is the NDJSON stream of events.ts.

export const channelSchema = z.enum(["voice", "chat"]);

export const conversationCreateSchema = z.object({ channel: channelSchema });

export const conversationSchema = z.object({
  id: z.uuid(),
  channel: channelSchema,
  state: z.string(),
  started_at: z.string(),
});
export type ConversationView = z.infer<typeof conversationSchema>;

/** A typed message or a chip tap; `speak` asks for the reply's audio too (spoken replies come with the voice step). */
export const chatMessageSchema = z
  .object({
    conversation_id: z.uuid(),
    text: z.string().trim().min(1).max(500).optional(),
    choice: z.object({ slot: z.string().min(1).max(40), option_id: z.string().min(1).max(40) }).optional(),
    speak: z.boolean().default(false),
  })
  .refine((body) => body.text !== undefined || body.choice !== undefined, {
    message: "text or choice is needed",
  });
export type ChatMessageBody = z.infer<typeof chatMessageSchema>;
