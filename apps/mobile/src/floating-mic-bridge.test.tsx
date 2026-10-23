import type { ReplyEvent } from "@dokaanbondhu/contracts";
import { act, render } from "@testing-library/react-native";
import { AppState } from "react-native";
import { FloatingMicBridge } from "./floating-mic-bridge";
import { useFloatingMicStatus } from "./lib/floating-mic";
import { useDeviceSettings } from "./lib/settings-store";
import { streamTurn } from "./lib/stream";
import { VoiceProvider } from "./lib/voice";

// The floating mic in the app (spec 15.9, D203) with the bubble, the recorder and the server replaced: it comes up
// when the switch is on and the phone allows it, with the app in front; holding the bubble asks a question as the
// page's button would, and dragging it drops the recording; the bubble shows the page's state and the newest reply's
// card, a write's with yes and no, whose Yes saves it aloud; the × turns the switch off; the speech worker is kept
// awake until nobody has pressed the bubble for 30 minutes; signing out takes the bubble down.

const mockListeners = new Map<string, (event?: unknown) => void>();
const mockMic = {
  isSupported: () => true,
  canDrawOverlays: jest.fn(() => true),
  openOverlaySettings: jest.fn(),
  isRunning: jest.fn(() => false),
  start: jest.fn(async (_labels: unknown) => undefined),
  stop: jest.fn(async () => undefined),
  update: jest.fn(async (_look: unknown) => undefined),
  addListener: (name: string, listener: (event?: unknown) => void) => {
    mockListeners.set(name, listener);
    return { remove: () => mockListeners.delete(name) };
  },
};
jest.mock("../modules/floating-mic", () => ({
  get FloatingMic() {
    return mockMic;
  },
}));

const mockRecorder = {
  prepareRecording: jest.fn(async () => undefined),
  startRecording: jest.fn(async (_config: unknown) => undefined),
  stopRecording: jest.fn(async () => ({})),
};
const mockMicPermission = { granted: true };
jest.mock("@siteed/audio-studio", () => ({
  useAudioRecorder: () => mockRecorder,
  AudioStudioModule: {
    getPermissionsAsync: async () => mockMicPermission,
    requestPermissionsAsync: async () => mockMicPermission,
  },
}));
jest.mock("expo-crypto", () => {
  let n = 0;
  return { randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
});
jest.mock("./lib/supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));
jest.mock("./lib/haptics", () => ({ buzz: jest.fn() }));
const mockHealth = {
  health: { speech: "ok" },
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
jest.mock("./lib/session", () => ({ useMe: () => ({ data: { providers: { speaks: true } } }) }));
jest.mock("./lib/audio", () => ({
  phonePlayer: {
    save: () => "file://x.mp3",
    play: async () => undefined,
    stopPlaying: () => undefined,
    remove: () => undefined,
  },
  playAskAgain: jest.fn(),
  stopPlayback: jest.fn(),
  removeOldRecordings: jest.fn(),
  usePlayback: jest.requireActual("zustand").create(() => ({ playing: false })),
}));
jest.mock("./lib/stream", () => ({ streamTurn: jest.fn(async () => undefined), uploadChunk: jest.fn() }));
const mockReplies: ReplyEvent[][] = [];
const mockStream = jest.fn(async (_path: string, _body: unknown, onEvent: (event: ReplyEvent) => void) => {
  for (const event of mockReplies.shift() ?? []) onEvent(event);
});
jest.mock("./lib/chat", () => {
  const { createChatStore } = jest.requireActual("./lib/chat-store");
  let n = 0;
  return {
    useChat: createChatStore({
      createConversation: async () => "conv-1",
      stream: (path: string, body: unknown, onEvent: (event: ReplyEvent) => void) =>
        mockStream(path, body, onEvent),
      forget: async () => undefined,
      newId: () => `m${++n}`,
    }),
  };
});

const ACTION = "6f1c1d2e-0000-4000-8000-000000000001";

/** 500 ms of a 200 Hz tone at amplitude 0.2, as the recorder's base64. */
const loud = () => {
  const bytes = Buffer.alloc(16_000);
  for (let i = 0; i < 8000; i++) bytes.writeInt16LE(Math.round(0.2 * 32767 * Math.sin(i / 12.7)), i * 2);
  return bytes.toString("base64");
};

const onChunk = async (base64: string) => {
  const config = mockRecorder.startRecording.mock.calls.at(-1)![0] as {
    onAudioStream: (event: { data: string }) => Promise<void>;
  };
  await config.onAudioStream({ data: base64 });
};

/** Something the bubble does, as its native side reports it. */
const bubble = async (name: string, event?: unknown) => {
  await act(async () => mockListeners.get(name)!(event));
};

const lastLook = () =>
  mockMic.update.mock.calls.at(-1)?.[0] as
    | {
        mode: string;
        level: number;
        card: { text: string; actionId?: string; yes?: string; no?: string } | null;
      }
    | undefined;

function App() {
  return (
    <VoiceProvider>
      <FloatingMicBridge />
    </VoiceProvider>
  );
}

/** Holds the bubble for a second of loud speech and lets go; the finish is sent on the clock. */
async function askByBubble() {
  await bubble("onPressIn");
  await act(async () => jest.advanceTimersByTime(500));
  await act(async () => onChunk(loud()));
  await act(async () => jest.advanceTimersByTime(500));
  await act(async () => onChunk(loud()));
  await bubble("onPressOut");
  await release();
}

/** After the release: the half second more of listening, then the wait for the recorder's last chunk (D103, D113). */
async function release() {
  await act(async () => jest.advanceTimersByTime(500));
  await act(async () => jest.advanceTimersByTime(700));
}

describe("floating mic bridge", () => {
  const before = Object.getOwnPropertyDescriptor(AppState, "currentState")!;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockListeners.clear();
    mockReplies.length = 0;
    mockMic.canDrawOverlays.mockReturnValue(true);
    mockMicPermission.granted = true;
    // The app in front (the test environment's AppState has no state of its own).
    Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
    useDeviceSettings.setState({ floatingMic: true });
    useFloatingMicStatus.setState({ running: false });
    jest.requireMock("./lib/chat").useChat.getState().reset();
  });
  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(AppState, "currentState", before);
  });

  it("brings the bubble up with the notification's words when the switch is on and the phone allows it", async () => {
    await render(<App />);
    expect(mockMic.start).toHaveBeenCalledWith({
      name: "floating.title",
      title: "floating.notification_title",
      text: "floating.notification_text",
      stop: "floating.stop",
      hold: "voice.hold",
    });
    expect(useFloatingMicStatus.getState().running).toBe(true);
    expect(lastLook()).toEqual({ mode: "ready", level: 0, card: null });
  });

  it("does not bring it up without the permission to draw over other apps, or with the app in the background", async () => {
    mockMic.canDrawOverlays.mockReturnValue(false);
    const first = await render(<App />);
    expect(mockMic.start).not.toHaveBeenCalled();
    await first.unmount();
    mockMic.canDrawOverlays.mockReturnValue(true);
    Object.defineProperty(AppState, "currentState", { value: "background", configurable: true });
    await render(<App />);
    expect(mockMic.start).not.toHaveBeenCalled();
  });

  it("takes the bubble down when the switch goes off, and when the app signs out", async () => {
    const app = await render(<App />);
    await act(async () => useDeviceSettings.setState({ floatingMic: false }));
    expect(mockMic.stop).toHaveBeenCalled();
    expect(useFloatingMicStatus.getState().running).toBe(false);
    await act(async () => useDeviceSettings.setState({ floatingMic: true }));
    mockMic.stop.mockClear();
    await app.unmount();
    expect(mockMic.stop).toHaveBeenCalledTimes(1);
  });

  it("asks a question held on the bubble as the page's button would, showing it is listening", async () => {
    await render(<App />);
    await bubble("onPressIn");
    expect(mockRecorder.startRecording).toHaveBeenCalledTimes(1);
    expect(lastLook()?.mode).toBe("listening");
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => onChunk(loud()));
    expect(lastLook()?.level).toBeGreaterThan(0);
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => onChunk(loud()));
    await bubble("onPressOut");
    await release();
    expect(streamTurn).toHaveBeenCalledWith(
      expect.stringMatching(/^\/voice\/turns\/.+\/finish$/),
      expect.objectContaining({ conversation_id: "conv-1", chunk_count: 2 }),
      expect.any(Function),
    );
  });

  it("drops the recording when the bubble is dragged instead of held: nothing is sent", async () => {
    await render(<App />);
    await bubble("onPressIn");
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => onChunk(loud()));
    await bubble("onCancel");
    expect(mockRecorder.stopRecording).toHaveBeenCalledTimes(1);
    expect(lastLook()?.mode).toBe("ready");
    await act(async () => jest.advanceTimersByTime(31_000)); // not even the 30 s limit sends it
    expect(streamTurn).not.toHaveBeenCalled();
  });

  it("shows the answer's text on the card while it is said, and puts it away 8 s after", async () => {
    await render(<App />);
    (streamTurn as jest.Mock).mockImplementationOnce(
      async (_path: string, _body: unknown, onEvent: (event: ReplyEvent) => void) => {
        onEvent({ type: "transcript", text: "এক্সিওর সামনের প্যাড আছে?", unclear: [] });
        onEvent({ type: "text", seq: 0, text: "এক্সিও ২০১৪-এর সামনের প্যাড আছে, B-3 তাকে।", final: true });
        onEvent({ type: "done", turn_id: "t1", state: "IDLE", timings_ms: {} });
      },
    );
    await askByBubble();
    expect(lastLook()?.card).toEqual({ text: "এক্সিও ২০১৪-এর সামনের প্যাড আছে, B-3 তাকে।" });
    await act(async () => jest.advanceTimersByTime(7_000));
    expect(lastLook()?.card).not.toBeNull();
    await act(async () => jest.advanceTimersByTime(1_500));
    expect(lastLook()?.card).toBeNull();
  });

  it("shows a write's confirmation with yes and no, and its Yes saves it with the reply spoken", async () => {
    await render(<App />);
    const expires = new Date(Date.now() + 60_000).toISOString();
    (streamTurn as jest.Mock).mockImplementationOnce(
      async (_path: string, _body: unknown, onEvent: (event: ReplyEvent) => void) => {
        onEvent({ type: "text", seq: 0, text: "এটা সেভ করব?", final: true });
        onEvent({
          type: "confirm",
          action_id: ACTION,
          text: "এক্সিওর সামনের প্যাড ২টা রহিম মোটরসকে বিক্রি করব?",
          fields: [],
          warnings: [],
          expires_at: expires,
        });
        onEvent({ type: "done", turn_id: "t1", state: "CONFIRMING", timings_ms: {} });
      },
    );
    await askByBubble();
    expect(lastLook()?.card).toEqual({
      text: "এক্সিওর সামনের প্যাড ২টা রহিম মোটরসকে বিক্রি করব?",
      actionId: ACTION,
      yes: "confirm.yes",
      no: "confirm.no",
    });
    // Still there after 30 s: a write's card stays until it is decided or expires.
    await act(async () => jest.advanceTimersByTime(30_000));
    expect(lastLook()?.card?.actionId).toBe(ACTION);
    mockReplies.push([
      { type: "action_result", action_id: ACTION, status: "done", undo_available: true },
      { type: "text", seq: 0, text: "সেভ হয়েছে।", final: true },
      { type: "done", turn_id: "t2", state: "IDLE", timings_ms: {} },
    ]);
    await bubble("onDecide", { actionId: ACTION, decision: "yes" });
    expect(mockStream).toHaveBeenCalledWith(
      `/actions/${ACTION}/decision`,
      { decision: "yes", speak: true },
      expect.any(Function),
    );
    expect(lastLook()?.card).toEqual({ text: "সেভ হয়েছে।" });
  });

  it("puts a write's card away when its confirmation expires", async () => {
    await render(<App />);
    const expires = new Date(Date.now() + 60_000).toISOString();
    (streamTurn as jest.Mock).mockImplementationOnce(
      async (_path: string, _body: unknown, onEvent: (event: ReplyEvent) => void) => {
        onEvent({
          type: "confirm",
          action_id: ACTION,
          text: "বিক্রি করব?",
          fields: [],
          warnings: [],
          expires_at: expires,
        });
        onEvent({ type: "done", turn_id: "t1", state: "CONFIRMING", timings_ms: {} });
      },
    );
    await askByBubble();
    expect(lastLook()?.card?.actionId).toBe(ACTION);
    await act(async () => jest.advanceTimersByTime(60_000));
    expect(lastLook()?.card).toBeNull();
  });

  it("turns the switch off when the bubble is dropped on the ×, but not when it only could not start", async () => {
    await render(<App />);
    await bubble("onClosed", { error: "not in front" });
    expect(useDeviceSettings.getState().floatingMic).toBe(true);
    expect(useFloatingMicStatus.getState().running).toBe(false);
    await bubble("onClosed", {});
    expect(useDeviceSettings.getState().floatingMic).toBe(false);
  });

  it("keeps the speech worker awake every 4 minutes until nobody has pressed it for 30, then wakes it on a press", async () => {
    await render(<App />);
    await act(async () => jest.advanceTimersByTime(4 * 60_000));
    expect(mockWake).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(28 * 60_000)); // 32 minutes without a press
    const woken = mockWake.mock.calls.length;
    expect(woken).toBe(7); // at 4, 8, ... 28 minutes
    await act(async () => jest.advanceTimersByTime(8 * 60_000));
    expect(mockWake).toHaveBeenCalledTimes(woken);
    await bubble("onPressIn"); // asleep by now: woken as the question is said
    expect(mockWake).toHaveBeenCalledTimes(woken + 1);
    await bubble("onCancel");
    await act(async () => jest.advanceTimersByTime(4 * 60_000));
    expect(mockWake).toHaveBeenCalledTimes(woken + 2);
  });
});
