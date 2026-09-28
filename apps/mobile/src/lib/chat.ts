import * as Crypto from "expo-crypto";
import { api } from "./api";
import { createChatStore } from "./chat-store";
import { streamTurn } from "./stream";

// The app's one chat store: a conversation is opened with the first message and kept until "new chat".
export const useChat = createChatStore({
  createConversation: async () =>
    (
      await api<{ conversation: { id: string } }>("/conversations", {
        method: "POST",
        body: { channel: "chat" },
      })
    ).conversation.id,
  stream: (path, body, onEvent) => streamTurn(path, body, onEvent),
  newId: () => Crypto.randomUUID(),
});
