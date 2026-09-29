import { voiceChunkQuerySchema } from "@dokaanbondhu/contracts";
import { z } from "zod";
import { appError } from "../../../../../../../src/server/errors";
import { route } from "../../../../../../../src/server/route";
import { addChunk } from "../../../../../../../src/server/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const turnIdSchema = z.uuid();

/**
 * POST /voice/turns/{turnId}/chunks?conversation_id=…&seq=… (any): one raw PCM chunk, sent every 500 ms while the
 * button is held (spec 8.4); 204. The turn needs no request to start: the phone makes its ID.
 */
export const POST = route<{ turnId: string }>(
  { role: "any", limit: "chunk" },
  async ({ request, caller, params }) => {
    const url = new URL(request.url);
    const query = voiceChunkQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    const turnId = turnIdSchema.safeParse(params.turnId);
    if (!query.success || !turnId.success) {
      throw appError("VALIDATION_FAILED", 400, {
        issues: [...(query.error?.issues ?? []), ...(turnId.error?.issues ?? [])].map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    addChunk(caller, turnId.data, query.data.conversation_id, query.data.seq, bytes);
    return new Response(null, { status: 204 });
  },
);
