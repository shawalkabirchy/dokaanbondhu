import type { ActionResultEvent, AssistantMessage } from "./chat-store";
import { bubbleMode, CARD_MS, cardLasts, cardOf, IDLE_MS, keepsAwake } from "./floating-mic";

// The floating mic's rules (spec 15.9, D203): the bubble looks as the page's button would; its card shows the newest
// reply's text, or a write's confirmation with yes and no until it is decided or expires, and goes a few seconds
// after the answer has been said; the speech worker is kept awake until nobody has pressed the bubble for 30 minutes.

const NOW = Date.parse("2026-10-23T10:00:00Z");

function reply(change: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    kind: "assistant",
    id: "m2",
    turnId: "t1",
    status: null,
    texts: [],
    cards: [],
    tables: [],
    choices: null,
    confirm: null,
    result: null,
    error: null,
    done: false,
    ...change,
  };
}

const confirm = (expiresAt: string) => ({
  type: "confirm" as const,
  action_id: "6f1c1d2e-0000-4000-8000-000000000001",
  text: "এক্সিও ২০১৪-এর সামনের প্যাড ২টা, ৯,০০০ টাকা, রহিম মোটরসকে বিক্রি করব?",
  fields: [],
  warnings: [],
  expires_at: expiresAt,
});

const words = { yes: "হ্যাঁ", no: "না", error: (key: string) => `(${key})` };
const none = new Map<string, ActionResultEvent>();

describe("floating mic rules", () => {
  it("looks as the page's button would: listening, working, speaking, off, waking, ready", () => {
    const idle = { recording: false, busy: false, playing: false, micAllowed: true, speechWaking: false };
    expect(bubbleMode(idle)).toBe("ready");
    // A hold that has started always finishes, even offline (D111).
    expect(bubbleMode({ ...idle, recording: true, micAllowed: false })).toBe("listening");
    expect(bubbleMode({ ...idle, busy: true })).toBe("working");
    expect(bubbleMode({ ...idle, playing: true })).toBe("speaking");
    expect(bubbleMode({ ...idle, micAllowed: false })).toBe("off");
    // The speech worker waking still lets a question be asked (D164).
    expect(bubbleMode({ ...idle, speechWaking: true })).toBe("waking");
  });

  it("shows the newest reply's text, or its error, once there is one", () => {
    expect(cardOf(undefined, none, words, NOW)).toBeNull();
    expect(cardOf(reply(), none, words, NOW)).toBeNull();
    const answer = reply({ texts: ["এক্সিও ২০১৪-এর সামনের প্যাড আছে।", "B-3 তাকে।"] });
    expect(cardOf(answer, none, words, NOW)).toEqual({ text: "এক্সিও ২০১৪-এর সামনের প্যাড আছে। B-3 তাকে।" });
    expect(cardOf(reply({ error: "errors.SPEECH_DOWN" }), none, words, NOW)).toEqual({
      text: "(errors.SPEECH_DOWN)",
    });
  });

  it("shows a write's confirmation with yes and no until it is decided or expires", () => {
    const waiting = reply({ texts: ["এটা সেভ করব?"], confirm: confirm("2026-10-23T10:01:00Z"), done: true });
    expect(cardOf(waiting, none, words, NOW)).toEqual({
      text: "এক্সিও ২০১৪-এর সামনের প্যাড ২টা, ৯,০০০ টাকা, রহিম মোটরসকে বিক্রি করব?",
      actionId: "6f1c1d2e-0000-4000-8000-000000000001",
      yes: "হ্যাঁ",
      no: "না",
      expiresAt: "2026-10-23T10:01:00Z",
    });
    // It goes when the confirmation expires, 60 s after it came.
    expect(cardLasts(cardOf(waiting, none, words, NOW)!, waiting, false, NOW)).toBe(60_000);
    // Expired: only the reply's own words are left, without the buttons.
    expect(cardOf(waiting, none, words, NOW + 61_000)).toEqual({ text: "এটা সেভ করব?" });
    // Decided (its action's result has come): no buttons either.
    const decided = new Map<string, ActionResultEvent>([
      [
        "6f1c1d2e-0000-4000-8000-000000000001",
        {
          type: "action_result",
          action_id: "6f1c1d2e-0000-4000-8000-000000000001",
          status: "done",
          undo_available: true,
        },
      ],
    ]);
    expect(cardOf(waiting, decided, words, NOW)?.actionId).toBeUndefined();
  });

  it("puts an answer's card away a few seconds after it has been said", () => {
    const card = { text: "আছে।" };
    expect(cardLasts(card, reply({ texts: ["আছে।"] }), false, NOW)).toBeNull(); // still streaming
    expect(cardLasts(card, reply({ texts: ["আছে।"], done: true }), true, NOW)).toBeNull(); // still being said
    expect(cardLasts(card, reply({ texts: ["আছে।"], done: true }), false, NOW)).toBe(CARD_MS);
  });

  it("keeps the speech worker awake until nobody has pressed the bubble for 30 minutes", () => {
    expect(keepsAwake(NOW, NOW + IDLE_MS - 1)).toBe(true);
    expect(keepsAwake(NOW, NOW + IDLE_MS)).toBe(false);
  });

  it("runs the JS task that keeps timers going until the bubble is gone", async () => {
    let register!: jest.SpyInstance;
    let rules!: typeof import("./floating-mic");
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AppRegistry } = require("react-native") as typeof import("react-native");
      register = jest.spyOn(AppRegistry, "registerHeadlessTask").mockImplementation(() => undefined);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      rules = require("./floating-mic");
    });
    const [name, provider] = register.mock.calls[0] as [string, () => (data: unknown) => Promise<void>];
    expect(name).toBe("FloatingMicAwake");
    let ended = false;
    const running = provider()({}).then(() => {
      ended = true;
    });
    await Promise.resolve();
    expect(ended).toBe(false);
    rules.letJsSleep();
    await running;
    expect(ended).toBe(true);
    register.mockRestore();
  });
});
