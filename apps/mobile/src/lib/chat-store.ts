import type { Remembered, RememberedKey, ReplyEvent } from "@dokaanbondhu/contracts";
import { create } from "zustand";
import { ApiError } from "./api";

// The conversation's state (spec 15.5): the one conversation the voice and chat pages share (D125), its messages, the
// turn that is running, and what the assistant remembers. Each reply event updates the assistant message it belongs
// to; chips answer only the newest question. The API calls are passed in, so the tests run without a server.

export type Channel = "voice" | "chat";

export type PartCard = Extract<ReplyEvent, { type: "cards" }>["parts"][number];
export type TableEvent = Extract<ReplyEvent, { type: "table" }>;
export type ChoicesEvent = Extract<ReplyEvent, { type: "choices" }>;
export type ConfirmEvent = Extract<ReplyEvent, { type: "confirm" }>;
export type ActionResultEvent = Extract<ReplyEvent, { type: "action_result" }>;

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
  /** A write waiting for yes or no: the confirmation sheet (spec 9.9, 15.2). */
  confirm: ConfirmEvent | null;
  /** What became of an action decided in this turn. */
  result: ActionResultEvent | null;
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
    case "confirm":
      return { ...message, confirm: event };
    case "action_result":
      return { ...message, result: event };
    case "error":
      return { ...message, error: event.message_key };
    case "done":
      return { ...message, turnId: event.turn_id, status: null, done: true };
    default:
      return message; // audio is played by the page
  }
}

export interface ChatDeps {
  /** Opens a conversation; the channel is the page that opened it (D126). */
  createConversation: (channel: Channel) => Promise<string>;
  stream: (path: string, body: unknown, onEvent: (event: ReplyEvent) => void) => Promise<void>;
  /** Forgets the remembered car or customer on the server (DELETE /conversations/{id}/context/{key}). */
  forget: (conversationId: string, key: RememberedKey) => Promise<void>;
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
  /** What the assistant remembers after the last turn, for the memory line (D125). */
  remembered: Remembered;
  /** The conversation's ID, opening it once if there is none yet, from the page that asks first. */
  ensureConversation: (channel?: Channel) => Promise<string>;
  /** Forgets the remembered car or customer: at once on screen, then on the server (D125). */
  forget: (key: RememberedKey) => Promise<void>;
  send: (input: ChatInput, options?: SendOptions) => Promise<void>;
  /** The confirmation sheet's yes or no (POST /actions/{id}/decision): a turn of the conversation, shown as said. */
  decide: (actionId: string, decision: "yes" | "no", label: string, options?: SendOptions) => Promise<void>;
  /**
   * Any turn: shows the user's words (a voice turn's are filled in by its transcript event) and an assistant message
   * that each reply event updates.
   */
  runTurn: (
    userText: string,
    run: (conversationId: string, onEvent: OnEvent) => Promise<void>,
    tap?: OnEvent,
    /** The label shown until the server's first status: searching for a typed question, understanding for a voice one
     * (D115). */
    firstStatus?: string,
  ) => Promise<void>;
  /**
   * A reply the app gives by itself, without the server: the voice page's "আবার বলবেন?" for a clip too quiet to send
   * (D114). The same note is not shown twice in a row.
   */
  note: (text: string) => void;
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
    /** The newest turn's reply: only it may end the busy state, so an older turn that finishes late cannot. */
    let active: string | null = null;
    const release = (replyId: string) => {
      if (active === replyId) set({ busy: false });
    };

    const ensureConversation = async (channel: Channel = "chat") => {
      const current = get().conversationId;
      if (current) return current;
      opening ??= deps.createConversation(channel).then(
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

    const runTurn: ChatState["runTurn"] = async (userText, run, tap, firstStatus = "status.searching") => {
      if (get().busy) return;
      const userId = deps.newId();
      const replyId = deps.newId();
      active = replyId;
      set((state) => ({
        busy: true,
        messages: [
          ...state.messages,
          { kind: "user", id: userId, text: userText },
          {
            kind: "assistant",
            id: replyId,
            turnId: null,
            status: firstStatus,
            texts: [],
            cards: [],
            tables: [],
            choices: null,
            confirm: null,
            result: null,
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
          if (event.type === "done" && event.context) set({ remembered: event.context });
          // The whole answer is on screen: the next question may start; the stream goes on only for the audio (D101).
          if (event.type === "text" && event.final) release(replyId);
          tap?.(event);
        });
      } catch (error) {
        // A conversation the server no longer knows is started again with the next message.
        if (error instanceof ApiError && error.body?.code === "CONVERSATION_NOT_FOUND")
          set({ conversationId: null, remembered: {} });
        const key = error instanceof ApiError && error.body ? `errors.${error.body.code}` : "common.error";
        update(replyId, (message) => ({ ...message, error: key }));
      } finally {
        update(replyId, (message) => ({ ...message, status: null, done: true }));
        release(replyId);
      }
    };

    const note: ChatState["note"] = (text) =>
      set((state) => {
        const last = state.messages.at(-1);
        if (last?.kind === "assistant" && last.turnId === null && last.done && last.texts.join("") === text)
          return state;
        const message: AssistantMessage = {
          kind: "assistant",
          id: deps.newId(),
          turnId: null,
          status: null,
          texts: [text],
          cards: [],
          tables: [],
          choices: null,
          confirm: null,
          result: null,
          error: null,
          done: true,
        };
        return { messages: [...state.messages, message] };
      });

    const forget: ChatState["forget"] = async (key) => {
      const { conversationId, remembered } = get();
      const item = remembered[key];
      if (!conversationId || !item) return;
      const kept = { ...remembered };
      delete kept[key];
      set({ remembered: kept });
      try {
        await deps.forget(conversationId, key);
      } catch {
        // Not forgotten on the server: shown again, unless a newer turn has said what is remembered since.
        if (get().remembered[key] === undefined && get().conversationId === conversationId)
          set({ remembered: { ...get().remembered, [key]: item } });
      }
    };

    return {
      conversationId: null,
      messages: [],
      busy: false,
      remembered: {},
      ensureConversation,
      forget,
      runTurn,
      note,
      reset: () => {
        active = null;
        set({ conversationId: null, messages: [], busy: false, remembered: {} });
      },
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
      decide: (actionId, decision, label, options = {}) =>
        runTurn(
          label,
          (_conversationId, onEvent) =>
            deps.stream(
              `/actions/${actionId}/decision`,
              { decision, ...(options.speak ? { speak: true } : {}) },
              onEvent,
            ),
          options.tap,
          "status.saving",
        ),
    };
  });
}
