import type { ReplyEvent } from "@dokaanbondhu/contracts";
import { ApiError } from "./api";
import { createChatStore, type AssistantMessage, type ChatDeps } from "./chat-store";

jest.mock("./supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));

// The chat page's state (spec 15.2, 15.5): reply events fill the assistant message in order, a chip tap is sent as
// a choice with its label shown as the user's message, and a refused request shows its error.

function store(events: ReplyEvent[][], overrides: Partial<ChatDeps> = {}) {
  let id = 0;
  const sent: unknown[] = [];
  const deps: ChatDeps = {
    createConversation: jest.fn(async () => "c1"),
    stream: jest.fn(async (_path, body, onEvent) => {
      sent.push(body);
      for (const event of events.shift() ?? []) onEvent(event);
    }),
    newId: () => `m${++id}`,
    ...overrides,
  };
  return { useChat: createChatStore(deps), deps, sent };
}

const reply = (useChat: ReturnType<typeof store>["useChat"]) =>
  useChat.getState().messages.filter((message): message is AssistantMessage => message.kind === "assistant");

describe("chat store", () => {
  it("opens a conversation once and fills the reply from its events", async () => {
    const { useChat, deps, sent } = store([
      [
        { type: "status", state: "UNDERSTANDING", label_key: "status.searching" },
        {
          type: "cards",
          parts: [
            {
              host_part_id: "p1",
              name: "Front brake pad set",
              stock: 3,
              price_taka: { retail: 4500 },
              rack: "B-3",
              fitment_verified: true,
            },
          ],
        },
        { type: "text", seq: 1, text: "দুটোই B-3 তাকে।", final: true },
        { type: "text", seq: 0, text: "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড আছে।", final: false },
        { type: "done", turn_id: "t1", state: "IDLE", timings_ms: {} },
      ],
      [],
    ]);
    await useChat.getState().send({ text: "এক্সিওর প্যাড আছে?" });
    await useChat.getState().send({ text: "আর পেছনের?" });

    expect(deps.createConversation).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([
      { conversation_id: "c1", text: "এক্সিওর প্যাড আছে?" },
      { conversation_id: "c1", text: "আর পেছনের?" },
    ]);
    const [first] = reply(useChat);
    expect(first).toMatchObject({
      turnId: "t1",
      done: true,
      status: null,
      texts: ["এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড আছে।", "দুটোই B-3 তাকে।"],
      cards: [{ rack: "B-3" }],
    });
    expect(useChat.getState().busy).toBe(false);
  });

  it("sends a chip tap as a choice and shows its label as what the user said", async () => {
    const { useChat, sent } = store([
      [
        {
          type: "choices",
          slot: "year",
          options: [
            { id: "opt-1", label: "2007–2013" },
            { id: "opt-2", label: "2014–2021" },
          ],
        },
        { type: "text", seq: 0, text: "কোন বছরের নোয়া?", final: true },
        { type: "done", turn_id: "t1", state: "CLARIFYING", timings_ms: {} },
      ],
      [],
    ]);
    await useChat.getState().send({ text: "নোয়ার সেলফ আছে?" });
    expect(reply(useChat)[0]?.choices?.options).toHaveLength(2);
    await useChat.getState().send({ choice: { slot: "year", option_id: "opt-2" }, label: "2014–2021" });
    expect(sent[1]).toEqual({ conversation_id: "c1", choice: { slot: "year", option_id: "opt-2" } });
    expect(useChat.getState().messages.map((message) => message.kind === "user" && message.text)).toContain(
      "2014–2021",
    );
  });

  it("shows the server's error, and opens a new conversation after CONVERSATION_NOT_FOUND", async () => {
    const refused = new ApiError(404, {
      code: "CONVERSATION_NOT_FOUND",
      message_en: "Not found.",
      message_bn: "পাওয়া যায়নি।",
      message_bn_key: "errors.CONVERSATION_NOT_FOUND",
    });
    const { useChat, deps } = store([], {
      stream: jest.fn(async () => {
        throw refused;
      }),
    });
    await useChat.getState().send({ text: "হ্যালো" });
    expect(reply(useChat)[0]).toMatchObject({ error: "errors.CONVERSATION_NOT_FOUND", done: true });
    expect(useChat.getState().conversationId).toBeNull();
    await useChat.getState().send({ text: "হ্যালো" });
    expect(deps.createConversation).toHaveBeenCalledTimes(2);
  });

  it("ignores a second message while a turn is running", async () => {
    let finish: () => void = () => {};
    const { useChat, deps } = store([], {
      stream: jest.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    });
    const first = useChat.getState().send({ text: "এক" });
    while (!(deps.stream as jest.Mock).mock.calls.length) await Promise.resolve(); // the first reply has started
    await useChat.getState().send({ text: "দুই" });
    finish();
    await first;
    expect(deps.stream).toHaveBeenCalledTimes(1);
  });

  // D101: the reply's audio keeps coming after its text; the user must not wait for it to ask again.
  it("is ready for the next question once the whole answer text is there, while its audio still streams", async () => {
    let finishFirst: () => void = () => {};
    let finishSecond: () => void = () => {};
    let emitFirst: (event: ReplyEvent) => void = () => {};
    const { useChat, deps } = store([], {
      stream: jest.fn(async (_path, _body, onEvent) => {
        if ((deps.stream as jest.Mock).mock.calls.length === 1) {
          emitFirst = onEvent;
          await new Promise<void>((resolve) => (finishFirst = resolve));
        } else {
          await new Promise<void>((resolve) => (finishSecond = resolve));
        }
      }),
    });
    const first = useChat.getState().send({ text: "নোয়ার সেলফ আছে?" });
    while (!(deps.stream as jest.Mock).mock.calls.length) await Promise.resolve();
    emitFirst({ type: "text", seq: 0, text: "কোন বছরের নোয়া?", final: true });
    expect(useChat.getState().busy).toBe(false); // the audio is still on its way

    const second = useChat.getState().send({ text: "২০১৬" });
    expect(useChat.getState().busy).toBe(true);
    finishFirst(); // the first turn's stream ends late
    await first;
    expect(useChat.getState().busy).toBe(true); // it does not end the newer turn's busy state
    while ((deps.stream as jest.Mock).mock.calls.length < 2) await Promise.resolve();
    finishSecond();
    await second;
    expect(useChat.getState().busy).toBe(false);
    expect(deps.stream).toHaveBeenCalledTimes(2);
  });

  // D114: the voice page's own "আবার বলবেন?" for a clip too quiet to send, shown as text.
  it("shows a note of the app's own as a finished reply, once in a row, without the server", () => {
    const { useChat, deps } = store([]);
    useChat.getState().note("আবার বলবেন?");
    useChat.getState().note("আবার বলবেন?");
    expect(reply(useChat)).toEqual([
      expect.objectContaining({ texts: ["আবার বলবেন?"], done: true, status: null }),
    ]);
    expect(useChat.getState().busy).toBe(false);
    expect(deps.stream).not.toHaveBeenCalled();
    expect(deps.createConversation).not.toHaveBeenCalled();
  });
});
