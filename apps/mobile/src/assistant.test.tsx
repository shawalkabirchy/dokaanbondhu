import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AppState } from "react-native";
import Assistant from "../app/(app)/assistant";
import { streamTurn, uploadChunk } from "./lib/stream";

// The assistant page (spec 15.3, 15.8, D166) with the recorder, the player and the server replaced: holding the button
// records, recording stops by itself at 30 s, a quiet clip never reaches finish, and the button is never locked while
// speech only had trouble or while a question is being recorded (D111); while the speech worker wakes the page says
// so and the button works, then it says voice is ready, and it keeps the worker awake while in front (D164). Typed
// questions go from the typing bar, spoken only with the speaker on; an example only fills the bar; a spoken answer
// can be stopped.

const mockRecorder = {
  prepareRecording: jest.fn(async () => undefined),
  startRecording: jest.fn(async (_config: unknown) => undefined),
  stopRecording: jest.fn(async () => ({})),
};

jest.mock("@siteed/audio-studio", () => ({
  useAudioRecorder: () => mockRecorder,
  AudioStudioModule: {
    getPermissionsAsync: async () => ({ granted: true }),
    requestPermissionsAsync: async () => ({ granted: true }),
  },
}));
jest.mock("expo-crypto", () => {
  let n = 0;
  return { randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
});
jest.mock("./lib/supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));
jest.mock("./lib/haptics", () => ({ buzz: jest.fn() }));
// The reminders card has its own tests (reminders-card.test.tsx).
jest.mock("./reminders-card", () => ({ RemindersCard: () => null }));
const mockHealth = {
  health: { speech: "unknown" },
  online: true,
  starting: false,
  checking: false,
  micAllowed: true,
  speechTrouble: false,
  speechWaking: false,
  refresh: jest.fn(),
};
const mockWake = jest.fn(async (_refresh: unknown) => undefined);
jest.mock("./lib/health", () => ({
  useHealth: () => mockHealth,
  wakeSpeech: (refresh: unknown) => mockWake(refresh),
}));
// The page in front, as on the phone (the test has no navigator).
jest.mock("expo-router", () => {
  const { useEffect } = jest.requireActual("react");
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) };
});
const mockMe = { data: { providers: { speaks: true } } };
jest.mock("./lib/session", () => ({ useMe: () => mockMe }));
jest.mock("./lib/audio", () => ({
  phonePlayer: {
    save: () => "file://x.mp3",
    play: async () => undefined,
    stopPlaying: () => undefined,
    remove: () => undefined,
  },
  playAskAgain: jest.fn(),
  stopPlayback: jest.fn(),
  usePlayback: jest.requireActual("zustand").create(() => ({ playing: false })),
}));
jest.mock("./lib/stream", () => ({ streamTurn: jest.fn(async () => undefined), uploadChunk: jest.fn() }));
const mockCreateConversation = jest.fn(async (_channel: string) => "conv-1");
const mockStream = jest.fn(async (_path: string, _body: unknown, _onEvent: unknown) => undefined);
jest.mock("./lib/chat", () => {
  const { createChatStore } = jest.requireActual("./lib/chat-store");
  let n = 0;
  return {
    useChat: createChatStore({
      createConversation: (channel: string) => mockCreateConversation(channel),
      stream: (path: string, body: unknown, onEvent: unknown) => mockStream(path, body, onEvent),
      forget: async () => undefined,
      newId: () => `m${++n}`,
    }),
  };
});

/** The recorder's onAudioStream, as the page configured it. */
const onChunk = async (base64: string) => {
  const config = mockRecorder.startRecording.mock.calls.at(-1)![0] as {
    onAudioStream: (event: { data: string }) => Promise<void>;
  };
  await config.onAudioStream({ data: base64 });
};

const audio = () =>
  jest.requireMock("./lib/audio") as {
    playAskAgain: jest.Mock;
    stopPlayback: jest.Mock;
    usePlayback: { setState: (state: { playing: boolean }) => void };
  };

describe("assistant page", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    Object.assign(mockHealth, {
      health: { speech: "unknown" },
      online: true,
      starting: false,
      micAllowed: true,
      speechTrouble: false,
      speechWaking: false,
    });
    mockMe.data.providers.speaks = true;
    audio().usePlayback.setState({ playing: false });
    jest.requireMock("./lib/chat").useChat.getState().reset();
  });
  afterEach(() => jest.useRealTimers());

  // D125, D126: one conversation for voice and typing, recorded as opened by voice when the page opens it early.
  it("opens the shared conversation as a voice one", async () => {
    await render(<Assistant />);
    expect(mockCreateConversation).toHaveBeenCalledWith("voice");
  });

  it("stops recording by itself at 30 s", async () => {
    await render(<Assistant />);
    const button = screen.getByRole("button", { name: "voice.hold" });
    await act(async () => fireEvent(button, "pressIn"));
    expect(mockRecorder.startRecording).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(29_000));
    expect(mockRecorder.stopRecording).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(1_000));
    expect(mockRecorder.stopRecording).toHaveBeenCalledTimes(1);
  });

  /** 500 ms of a 200 Hz tone at amplitude 0.2, as the recorder's base64. */
  const loud = () => {
    const bytes = Buffer.alloc(16_000);
    for (let i = 0; i < 8000; i++) bytes.writeInt16LE(Math.round(0.2 * 32767 * Math.sin(i / 12.7)), i * 2);
    return bytes.toString("base64");
  };

  // D103: the recorder sends its last partial chunk a moment after stopRecording resolves.
  it("waits for the recorder's last chunk after release and sends it with the question", async () => {
    await render(<Assistant />);
    const button = screen.getByRole("button", { name: "voice.hold" });
    await act(async () => fireEvent(button, "pressIn"));
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => onChunk(loud()));
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => onChunk(loud()));
    mockRecorder.stopRecording.mockImplementationOnce(async () => {
      setTimeout(() => void onChunk(loud()), 100); // the last chunk, after the stop
      return {};
    });
    await act(async () => void fireEvent(button, "pressOut")); // release; the rest runs on the clock below
    // D113: the recorder keeps listening for half a second after the release, so the last word is not cut.
    await act(async () => jest.advanceTimersByTime(499));
    expect(mockRecorder.stopRecording).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(1));
    expect(mockRecorder.stopRecording).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(150));
    expect(uploadChunk).toHaveBeenCalledTimes(3);
    expect(streamTurn).toHaveBeenCalledWith(
      expect.stringMatching(/\/finish$/),
      expect.objectContaining({ chunk_count: 3, duration_ms: 1000 }), // the duration is the hold, without the tail
      expect.any(Function),
    );
  });

  // D166: what the user sees while holding: listening, with the seconds held.
  it("says it is listening while the button is held", async () => {
    await render(<Assistant />);
    await act(async () => fireEvent(screen.getByRole("button", { name: "voice.hold" }), "pressIn"));
    expect(screen.getByText("status.listening")).toBeTruthy();
    expect(screen.getByText("assistant.held")).toBeTruthy();
    expect(jest.requireMock("./lib/haptics").buzz).toHaveBeenCalledWith("press");
    await act(async () => jest.advanceTimersByTime(30_000));
  });

  // D115: the reply showed "খুঁজছি…", then "শুনছি…", then "খুঁজছি…"; it now only moves forward.
  it("shows the question being understood, not searched, until the server's first status", async () => {
    let finish: () => void = () => undefined;
    (streamTurn as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    await render(<Assistant />);
    const button = screen.getByRole("button", { name: "voice.hold" });
    await act(async () => fireEvent(button, "pressIn"));
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => onChunk(loud()));
    await act(async () => void fireEvent(button, "pressOut"));
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => jest.advanceTimersByTime(700));
    expect(streamTurn).toHaveBeenCalledTimes(1);
    expect(screen.getByText("status.understanding")).toBeTruthy();
    expect(screen.queryByText("status.searching")).toBeNull();
    await act(async () => finish());
  });

  it("stops at once after a tap, without the half second more", async () => {
    await render(<Assistant />);
    const button = screen.getByRole("button", { name: "voice.hold" });
    await act(async () => fireEvent(button, "pressIn"));
    await act(async () => jest.advanceTimersByTime(100));
    await act(async () => void fireEvent(button, "pressOut"));
    expect(mockRecorder.stopRecording).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(700));
    expect(streamTurn).not.toHaveBeenCalled();
  });

  it("drops a chunk that comes after the question was sent, so it never joins the next one", async () => {
    await render(<Assistant />);
    const button = screen.getByRole("button", { name: "voice.hold" });
    await act(async () => fireEvent(button, "pressIn"));
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => onChunk(loud()));
    await act(async () => void fireEvent(button, "pressOut")); // release; the rest runs on the clock below
    await act(async () => jest.advanceTimersByTime(500)); // the half second more (D113)
    await act(async () => jest.advanceTimersByTime(700)); // no last chunk: the wait gives up
    expect(streamTurn).toHaveBeenCalledTimes(1);
    const uploads = (uploadChunk as jest.Mock).mock.calls.length;
    await act(async () => onChunk(loud())); // far too late
    expect((uploadChunk as jest.Mock).mock.calls.length).toBe(uploads);
  });

  it("sends no finish for a quiet clip", async () => {
    await render(<Assistant />);
    const button = screen.getByRole("button", { name: "voice.hold" });
    await act(async () => fireEvent(button, "pressIn"));
    await act(async () => jest.advanceTimersByTime(1_000));
    await act(async () => onChunk(Buffer.alloc(16_000).toString("base64"))); // silence
    await act(async () => void fireEvent(button, "pressOut")); // release; the rest runs on the clock below
    await act(async () => jest.advanceTimersByTime(500)); // the half second more (D113)
    await act(async () => jest.advanceTimersByTime(700)); // no last chunk comes
    expect(streamTurn).not.toHaveBeenCalled();
    expect(audio().playAskAgain).toHaveBeenCalled();
    expect(screen.getByText("আবার বলবেন?")).toBeTruthy(); // as text too (D114)
    expect(uploadChunk).toHaveBeenCalled(); // the press was long enough to upload, just too quiet to finish
  });

  // D114: with reading aloud switched off by the developer (AI_SPEAK=off) the app makes no sound at all.
  it("asks again as text only when speaking is switched off", async () => {
    mockMe.data.providers.speaks = false;
    await render(<Assistant />);
    const button = screen.getByRole("button", { name: "voice.hold" });
    await act(async () => fireEvent(button, "pressIn"));
    await act(async () => jest.advanceTimersByTime(1_000));
    await act(async () => onChunk(Buffer.alloc(16_000).toString("base64"))); // silence
    await act(async () => void fireEvent(button, "pressOut"));
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => jest.advanceTimersByTime(700));
    expect(screen.getByText("আবার বলবেন?")).toBeTruthy();
    expect(audio().playAskAgain).not.toHaveBeenCalled();
    expect(streamTurn).not.toHaveBeenCalled();
  });

  // From the owner's test on 30 Sep (D111): one "audio too short" locked the microphone for five minutes.
  it("keeps the button working when speech had trouble, with a warning", async () => {
    mockHealth.speechTrouble = true;
    await render(<Assistant />);
    expect(screen.getByText("offline.speech_trouble")).toBeTruthy();
    await act(async () => fireEvent(screen.getByRole("button", { name: "voice.hold" }), "pressIn"));
    expect(mockRecorder.startRecording).toHaveBeenCalledTimes(1);
  });

  it("turns the button off while the server is offline", async () => {
    mockHealth.online = false;
    mockHealth.micAllowed = false;
    await render(<Assistant />);
    expect(screen.getByText("offline.mic_off")).toBeTruthy();
    await act(async () => fireEvent(screen.getByRole("button", { name: "voice.hold" }), "pressIn"));
    expect(mockRecorder.startRecording).not.toHaveBeenCalled();
  });

  // From the owner on 13 Oct (D164): a server that has not answered yet may be waking on Render, not offline.
  it("shows the button as starting, not voice off, while the server may still be waking", async () => {
    Object.assign(mockHealth, { online: false, micAllowed: false, starting: true });
    await render(<Assistant />);
    expect(screen.getByText("status.starting")).toBeTruthy();
    expect(screen.queryByText("offline.mic_off")).toBeNull();
    await act(async () => fireEvent(screen.getByRole("button", { name: "voice.hold" }), "pressIn"));
    expect(mockRecorder.startRecording).not.toHaveBeenCalled();
  });

  it("says voice is getting ready while the speech worker wakes, then for 5 s that it is ready", async () => {
    Object.assign(mockHealth, { speechWaking: true, health: { speech: "waking" } });
    await render(<Assistant />);
    expect(screen.getByText("voice.waking")).toBeTruthy();
    Object.assign(mockHealth, { speechWaking: false, health: { speech: "ok" } });
    await screen.rerender(<Assistant />);
    expect(screen.queryByText("voice.waking")).toBeNull();
    expect(screen.getByText("voice.ready")).toBeTruthy();
    await act(async () => jest.advanceTimersByTime(5000));
    expect(screen.queryByText("voice.ready")).toBeNull();
  });

  it("keeps the button working while voice is getting ready", async () => {
    Object.assign(mockHealth, { speechWaking: true, health: { speech: "waking" } });
    await render(<Assistant />);
    await act(async () => fireEvent(screen.getByRole("button", { name: "voice.hold" }), "pressIn"));
    expect(mockRecorder.startRecording).toHaveBeenCalledTimes(1);
  });

  it("wakes the speech worker every 4 minutes while the page is in front, and not after it is left", async () => {
    // The app in use (the test environment's AppState has no state of its own).
    const before = Object.getOwnPropertyDescriptor(AppState, "currentState")!;
    Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
    try {
      const { unmount } = await render(<Assistant />);
      expect(mockWake).not.toHaveBeenCalled();
      await act(async () => jest.advanceTimersByTime(4 * 60_000));
      expect(mockWake).toHaveBeenCalledTimes(1);
      await act(async () => jest.advanceTimersByTime(4 * 60_000));
      expect(mockWake).toHaveBeenCalledTimes(2);
      await unmount();
      await act(async () => jest.advanceTimersByTime(8 * 60_000));
      expect(mockWake).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(AppState, "currentState", before);
    }
  });

  it("finishes and sends a question even when the server goes offline while the button is held", async () => {
    await render(<Assistant />);
    const button = screen.getByRole("button", { name: "voice.hold" });
    await act(async () => fireEvent(button, "pressIn"));
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => onChunk(loud()));
    mockHealth.online = false;
    mockHealth.micAllowed = false;
    await screen.rerender(<Assistant />);
    await act(async () => void fireEvent(button, "pressOut"));
    await act(async () => jest.advanceTimersByTime(500)); // the half second more (D113)
    await act(async () => jest.advanceTimersByTime(700));
    expect(streamTurn).toHaveBeenCalledWith(
      expect.stringMatching(/\/finish$/),
      expect.objectContaining({ chunk_count: 1 }),
      expect.any(Function),
    );
  });

  // D166: typing on the same page, in the same conversation.
  it("sends a typed question from the typing bar, asking for audio only while the speaker is on", async () => {
    await render(<Assistant />);
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "assistant.keyboard" })));
    await act(async () =>
      fireEvent.changeText(screen.getByLabelText("chat.placeholder"), "axio 2014 brake pad ache?"),
    );
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "chat.send" })));
    expect(mockStream).toHaveBeenCalledWith(
      "/chat/messages",
      { conversation_id: "conv-1", text: "axio 2014 brake pad ache?" },
      expect.any(Function),
    );
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "chat.speak" })));
    await act(async () => fireEvent.changeText(screen.getByLabelText("chat.placeholder"), "এক্সিও ২০১৪"));
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "chat.send" })));
    expect(mockStream).toHaveBeenLastCalledWith(
      "/chat/messages",
      { conversation_id: "conv-1", text: "এক্সিও ২০১৪", speak: true },
      expect.any(Function),
    );
    // Back to the talk button.
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "assistant.mic" })));
    expect(screen.getByRole("button", { name: "voice.hold" })).toBeTruthy();
  });

  it("puts an example question in the typing bar without sending it", async () => {
    await render(<Assistant />);
    await act(async () => fireEvent.press(screen.getByText("assistant.examples.sale.text")));
    expect(screen.getByDisplayValue("assistant.examples.sale.text")).toBeTruthy();
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("shows speaking with a stop button while an answer plays, and stops it", async () => {
    await render(<Assistant />);
    await act(async () => audio().usePlayback.setState({ playing: true }));
    expect(screen.getByText("status.speaking")).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText("assistant.stop")));
    expect(audio().stopPlayback).toHaveBeenCalled();
  });
});
