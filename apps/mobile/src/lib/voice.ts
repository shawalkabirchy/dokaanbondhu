import * as Crypto from "expo-crypto";
import { api } from "./api";
import { createChatStore } from "./chat-store";
import { streamTurn } from "./stream";

// The voice page's store: the same turns as the chat page, in a conversation of the voice channel, so spoken
// questions and tapped chips share one context (spec 15.2).
export const useVoice = createChatStore({
  createConversation: async () =>
    (
      await api<{ conversation: { id: string } }>("/conversations", {
        method: "POST",
        body: { channel: "voice" },
      })
    ).conversation.id,
  stream: (path, body, onEvent) => streamTurn(path, body, onEvent),
  newId: () => Crypto.randomUUID(),
});
