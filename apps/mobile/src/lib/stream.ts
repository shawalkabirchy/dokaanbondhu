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
