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
      return message; // audio is played by the page; confirm and action results come with the write step
  }
}

export interface ChatDeps {
  createConversation: () => Promise<string>;
  stream: (path: string, body: unknown, onEvent: (event: ReplyEvent) => void) => Promise<void>;
  newId: () => string;
}

type OnEvent = (event: ReplyEvent) => void;

export interface SendOptions {
  /** Ask for the spoken reply too (the chat page's speaker, D88). */
  speak?: boolean;
  /** Sees every event of the turn as well, e.g. to play its audio. */
  tap?: OnEvent;
}

export interface ChatState {
  conversationId: string | null;
  messages: ChatMessage[];
  busy: boolean;
  /** The conversation's ID, opening it once if there is none yet. */
  ensureConversation: () => Promise<string>;
  send: (input: ChatInput, options?: SendOptions) => Promise<void>;
  /**
   * Any turn: shows the user's words (a voice turn's are filled in by its transcript event) and an assistant message
   * that each reply event updates.
   */
  runTurn: (
    userText: string,
    run: (conversationId: string, onEvent: OnEvent) => Promise<void>,
    tap?: OnEvent,
  ) => Promise<void>;
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
    let opening: Promise<string> | null = null;

    const ensureConversation = async () => {
      const current = get().conversationId;
      if (current) return current;
      opening ??= deps.createConversation().then(
        (id) => {
          set({ conversationId: id });
          opening = null;
          return id;
        },
        (error: unknown) => {
          opening = null;
          throw error;
        },
      );
      return opening;
    };

    const runTurn: ChatState["runTurn"] = async (userText, run, tap) => {
      if (get().busy) return;
      const userId = deps.newId();
      const replyId = deps.newId();
      set((state) => ({
        busy: true,
        messages: [
          ...state.messages,
          { kind: "user", id: userId, text: userText },
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
        const conversationId = await ensureConversation();
        await run(conversationId, (event) => {
          if (event.type === "transcript") {
            set((state) => ({
              messages: state.messages.map((message) =>
                message.kind === "user" && message.id === userId ? { ...message, text: event.text } : message,
              ),
            }));
          } else {
            update(replyId, (message) => applyEvent(message, event));
          }
          tap?.(event);
        });
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
    };

    return {
      conversationId: null,
      messages: [],
      busy: false,
      ensureConversation,
      runTurn,
      reset: () => set({ conversationId: null, messages: [], busy: false }),
      send: (input, options = {}) =>
        runTurn(
          "text" in input ? input.text : input.label,
          (conversationId, onEvent) =>
            deps.stream(
              "/chat/messages",
              {
                conversation_id: conversationId,
                ...("text" in input ? { text: input.text } : { choice: input.choice }),
                ...(options.speak ? { speak: true } : {}),
              },
              onEvent,
            ),
          options.tap,
        ),
    };
  });
}
