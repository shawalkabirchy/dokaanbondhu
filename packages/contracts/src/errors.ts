import { z } from "zod";

// The error shape of every endpoint that does not stream, the same nested shape GearGrid uses (spec 8.6).

export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "SETUP_TOKEN_INVALID",
  "FORBIDDEN",
  "USER_DISABLED",
  "UNDO_NOT_ALLOWED",
  "EXTERNAL_PROVIDERS_NOT_ALLOWED",
  "NOT_FOUND",
  "TURN_NOT_FOUND",
  "CONVERSATION_NOT_FOUND",
  "CHUNKS_MISSING",
  "ACTION_EXPIRED",
  "ACTION_NOT_PENDING",
  "UNDO_NOT_AVAILABLE",
  "CAPABILITY_NOT_VERIFIED",
  "CHUNK_TOO_LARGE",
  "TURN_TOO_LONG",
  "RATE_LIMITED",
  "CONNECTION_FAILED",
  "HOST_ERROR",
  "ASSISTANT_UNAVAILABLE",
  "SPEECH_UNAVAILABLE",
  "TTS_UNAVAILABLE",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorBodySchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message_en: z.string(),
    message_bn: z.string(),
    message_bn_key: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;
