import { chatMessageSchema } from "@dokaanbondhu/contracts";
import { readBody, route } from "../../../../../src/server/route";
import { chatTurn, isEvalRequest, loadConversation, ndjsonResponse } from "../../../../../src/server/turns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /chat/messages (any): { conversation_id, text?, choice?, speak? } -> the NDJSON reply stream (spec 8.3, 8.5). */
export const POST = route({ role: "any", limit: "turn" }, async ({ request, caller, requestId }) => {
  const body = await readBody(request, chatMessageSchema);
  const conversation = await loadConversation(caller, body.conversation_id);
  const evalMode = isEvalRequest(request);
  return ndjsonResponse((emit) =>
    chatTurn(
      {
        caller,
        conversation,
        ...(body.text ? { text: body.text } : {}),
        ...(body.choice ? { choice: { slot: body.choice.slot, optionId: body.choice.option_id } } : {}),
        evalMode,
        requestId,
      },
      emit,
    ),
  );
});
