import * as Crypto from "expo-crypto";
import { api } from "./api";
import { createChatStore } from "./chat-store";
import { streamTurn } from "./stream";

// The app's one conversation store, shared by the voice and chat pages (D125): spoken and typed turns land in one
// conversation, so a question asked by voice can be finished by typing. It is opened with the first turn, by the page
// that asks first, and kept until "new chat".
export const useChat = createChatStore({
  createConversation: async (channel) =>
    (
      await api<{ conversation: { id: string } }>("/conversations", {
        method: "POST",
        body: { channel },
      })
    ).conversation.id,
  stream: (path, body, onEvent) => streamTurn(path, body, onEvent),
  forget: async (conversationId, key) => {
    await api(`/conversations/${conversationId}/context/${key}`, { method: "DELETE" });
  },
  newId: () => Crypto.randomUUID(),
});
