import { readReplyStream, type ReplyEvent } from "@dokaanbondhu/contracts";
import { fetch } from "expo/fetch";
import { apiError, apiHeaders, apiUrl } from "./api";

// A turn's reply stream (spec 15.4): fetch from expo/fetch, so the body can be read while it arrives; each complete
// line is checked with the contracts schemas and handed over at once. A request the server refuses before streaming
// (a 4xx with the error body) becomes an ApiError.

export async function streamTurn(
  path: string,
  body: unknown,
  onEvent: (event: ReplyEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: await apiHeaders(),
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw apiError(response.status, await response.json().catch(() => null));
  if (!response.body) throw new Error("the reply has no body");
  await readReplyStream(response.body.getReader(), onEvent);
}

/** One voice chunk (spec 8.4): the raw PCM bytes as the body; the server answers 204. */
export async function uploadChunk(
  turnId: string,
  conversationId: string,
  seq: number,
  bytes: Uint8Array,
): Promise<void> {
  const headers = await apiHeaders();
  const response = await fetch(
    apiUrl(`/voice/turns/${turnId}/chunks?conversation_id=${conversationId}&seq=${seq}`),
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/octet-stream" },
      body: new Uint8Array(bytes), // a copy over its own ArrayBuffer
    },
  );
  if (!response.ok) throw apiError(response.status, await response.json().catch(() => null));
}
