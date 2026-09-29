import { z } from "zod";

// Voice upload (spec 8.4): raw PCM chunks while the button is held, then finish. The reply to finish is the NDJSON
// stream of events.ts.

/** 16-bit little-endian mono PCM at 16 kHz. */
export const VOICE_SAMPLE_RATE = 16_000;
/** A chunk over 64 KB is refused (CHUNK_TOO_LARGE). */
export const MAX_CHUNK_BYTES = 64 * 1024;
/** A turn holds at most 30.5 s of audio (TURN_TOO_LONG). */
export const MAX_TURN_MS = 30_500;

/** The chunk path's query: POST /voice/turns/{turnId}/chunks?conversation_id=…&seq=… */
export const voiceChunkQuerySchema = z.object({
  conversation_id: z.uuid(),
  seq: z.coerce.number().int().min(0).max(200),
});

export const voiceFinishSchema = z
  .object({
    conversation_id: z.uuid(),
    chunk_count: z.number().int().min(1).max(200),
    duration_ms: z.number().int().min(0).max(60_000),
    rms: z.number().min(0).max(1),
  })
  .strict();
export type VoiceFinishBody = z.infer<typeof voiceFinishSchema>;
