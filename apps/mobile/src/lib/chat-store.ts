import type { ReplyEvent } from "@dokaanbondhu/contracts";
import { create } from "zustand";
import { ApiError } from "./api";

// The chat page's state (spec 15.5): the conversation, its messages, and the turn that is running. Each reply event
// updates the assistant message it belongs to; chips answer only the newest question. The API calls are passed in,
// so the tests run without a server.

export type PartCard = Extract<ReplyEvent, { type: "cards" }>["parts"][number];
export type TableEvent = Extract<ReplyEvent, { type: "table" }>;
export type ChoicesEvent = Extract<ReplyEvent, { type: "choices" }>;

export interface UserMessage {
  kind: "user";
  id: string;
  text: string;
}

export interface AssistantMessage {
  kind: "assistant";
  id: string;
  turnId: string | null;
  /** The status label key while the turn runs, e.g. status.searching. */
  status: string | null;
  texts: string[];
  cards: PartCard[];
  tables: TableEvent[];
  choices: ChoicesEvent | null;
  /** An error message key (errors.<CODE> or common.error). */
  error: string | null;
  done: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage;

export type ChatInput = { text: string } | { choice: { slot: string; option_id: string }; label: string };

/** One reply event applied to its assistant message (a new object; the old one is left as it was). */
export function applyEvent(message: AssistantMessage, event: ReplyEvent): AssistantMessage {
  switch (event.type) {
    case "status":
      return { ...message, status: event.label_key };
    case "text": {
      const texts = [...message.texts];
      texts[event.seq] = event.text;
      return { ...message, texts };
    }
    case "cards":
      return { ...message, cards: [...message.cards, ...event.parts] };
    case "table":
      return { ...message, tables: [...message.tables, event] };
    case "choices":
      return { ...message, choices: event };
    case "error":
      return { ...message, error: event.message_key };
    case "done":
      return { ...message, turnId: event.turn_id, status: null, done: true };
    default:
      return message; // transcript, audio, confirm and action results come with the voice and write steps
  }
}

export interface ChatDeps {
  createConversation: () => Promise<string>;
  stream: (path: string, body: unknown, onEvent: (event: ReplyEvent) => void) => Promise<void>;
  newId: () => string;
}

export interface ChatState {
  conversationId: string | null;
  messages: ChatMessage[];
  busy: boolean;
  send: (input: ChatInput) => Promise<void>;
  reset: () => void;
}

export function createChatStore(deps: ChatDeps) {
  return create<ChatState>((set, get) => {
    const update = (id: string, change: (message: AssistantMessage) => AssistantMessage) =>
      set((state) => ({
        messages: state.messages.map((message) =>
          message.kind === "assistant" && message.id === id ? change(message) : message,
        ),
      }));

    return {
      conversationId: null,
      messages: [],
      busy: false,
      reset: () => set({ conversationId: null, messages: [], busy: false }),
      send: async (input) => {
        if (get().busy) return;
        const replyId = deps.newId();
        const userText = "text" in input ? input.text : input.label;
        set((state) => ({
          busy: true,
          messages: [
            ...state.messages,
            { kind: "user", id: deps.newId(), text: userText },
            {
              kind: "assistant",
              id: replyId,
              turnId: null,
              status: "status.searching",
              texts: [],
              cards: [],
              tables: [],
              choices: null,
              error: null,
              done: false,
            },
          ],
        }));
        try {
          let conversationId = get().conversationId;
          if (!conversationId) {
            conversationId = await deps.createConversation();
            set({ conversationId });
          }
          const body =
            "text" in input
              ? { conversation_id: conversationId, text: input.text }
              : { conversation_id: conversationId, choice: input.choice };
          await deps.stream("/chat/messages", body, (event) =>
            update(replyId, (message) => applyEvent(message, event)),
          );
        } catch (error) {
          // A conversation the server no longer knows is started again with the next message.
          if (error instanceof ApiError && error.body?.code === "CONVERSATION_NOT_FOUND")
            set({ conversationId: null });
          const key = error instanceof ApiError && error.body ? `errors.${error.body.code}` : "common.error";
          update(replyId, (message) => ({ ...message, error: key }));
        } finally {
          update(replyId, (message) => ({ ...message, status: null, done: true }));
          set({ busy: false });
        }
      },
    };
  });
}
