import { voiceFinishSchema } from "@dokaanbondhu/contracts";
import { z } from "zod";
import { appError } from "../../../../../../../src/server/errors";
import { readBody, route } from "../../../../../../../src/server/route";
import {
  isEvalRequest,
  loadConversation,
  ndjsonResponse,
  voiceTurn,
} from "../../../../../../../src/server/turns";
import { takeClip } from "../../../../../../../src/server/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const turnIdSchema = z.uuid();

/**
 * POST /voice/turns/{turnId}/finish (any): { conversation_id, chunk_count, duration_ms, rms } when the button is
 * released (spec 8.4). Missing chunks: 409 CHUNKS_MISSING with details.missing; otherwise the NDJSON reply stream.
 */
export const POST = route<{ turnId: string }>(
  { role: "any", limit: "turn" },
  async ({ request, caller, params, requestId }) => {
    const turnId = turnIdSchema.safeParse(params.turnId);
    if (!turnId.success) throw appError("TURN_NOT_FOUND", 404);
    const body = await readBody(request, voiceFinishSchema);
    const conversation = await loadConversation(caller, body.conversation_id);
    const pcm = await takeClip(caller, turnId.data, body.conversation_id, body.chunk_count);
    const evalMode = isEvalRequest(request);
    return ndjsonResponse((emit) =>
      voiceTurn(
        { caller, conversation, evalMode, requestId, speak: true },
        { pcm, durationMs: body.duration_ms, rms: body.rms },
        emit,
      ),
    );
  },
);
