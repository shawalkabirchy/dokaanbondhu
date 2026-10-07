import { act, fireEvent, render, screen } from "@testing-library/react-native";
import Voice from "../app/(app)/voice";
import { streamTurn, uploadChunk } from "./lib/stream";

// The voice page (spec 15.3, 15.8) with the recorder, the player and the server replaced: holding the button records,
// recording stops by itself at 30 s, a quiet clip never reaches finish, and the button is never locked while speech
// only had trouble or while a question is being recorded (D111).

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
const mockHealth = {
  online: true,
  checking: false,
  micAllowed: true,
  speechTrouble: false,
  refresh: jest.fn(),
};
jest.mock("./lib/health", () => ({ useHealth: () => mockHealth }));
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
}));
jest.mock("./lib/stream", () => ({ streamTurn: jest.fn(async () => undefined), uploadChunk: jest.fn() }));
const mockCreateConversation = jest.fn(async (_channel: string) => "conv-1");
jest.mock("./lib/chat", () => {
  const { createChatStore } = jest.requireActual("./lib/chat-store");
  let n = 0;
  return {
    useChat: createChatStore({
      createConversation: (channel: string) => mockCreateConversation(channel),
      stream: async () => undefined,
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

describe("voice page", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    Object.assign(mockHealth, { online: true, micAllowed: true, speechTrouble: false });
    mockMe.data.providers.speaks = true;
  });
  afterEach(() => jest.useRealTimers());

  // D125, D126: one conversation for both pages, recorded as opened by the page that asked first.
  it("opens the shared conversation as a voice one", async () => {
    await render(<Voice />);
    expect(mockCreateConversation).toHaveBeenCalledWith("voice");
  });

  it("stops recording by itself at 30 s", async () => {
    await render(<Voice />);
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
    await render(<Voice />);
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

  // D115: the reply showed "খুঁজছি…", then "শুনছি…", then "খুঁজছি…"; it now only moves forward.
  it("shows the question being understood, not searched, until the server's first status", async () => {
    let finish: () => void = () => undefined;
    (streamTurn as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    await render(<Voice />);
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
    await render(<Voice />);
    const button = screen.getByRole("button", { name: "voice.hold" });
    await act(async () => fireEvent(button, "pressIn"));
    await act(async () => jest.advanceTimersByTime(100));
    await act(async () => void fireEvent(button, "pressOut"));
    expect(mockRecorder.stopRecording).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(700));
    expect(streamTurn).not.toHaveBeenCalled();
  });

  it("drops a chunk that comes after the question was sent, so it never joins the next one", async () => {
    await render(<Voice />);
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
    await render(<Voice />);
    const button = screen.getByRole("button", { name: "voice.hold" });
    await act(async () => fireEvent(button, "pressIn"));
    await act(async () => jest.advanceTimersByTime(1_000));
    await act(async () => onChunk(Buffer.alloc(16_000).toString("base64"))); // silence
    await act(async () => void fireEvent(button, "pressOut")); // release; the rest runs on the clock below
    await act(async () => jest.advanceTimersByTime(500)); // the half second more (D113)
    await act(async () => jest.advanceTimersByTime(700)); // no last chunk comes
    expect(streamTurn).not.toHaveBeenCalled();
    expect(jest.requireMock("./lib/audio").playAskAgain).toHaveBeenCalled();
    expect(screen.getByText("আবার বলবেন?")).toBeTruthy(); // as text too (D114)
    expect(uploadChunk).toHaveBeenCalled(); // the press was long enough to upload, just too quiet to finish
  });

  // D114: with reading aloud switched off by the developer (AI_SPEAK=off) the app makes no sound at all.
  it("asks again as text only when speaking is switched off", async () => {
    mockMe.data.providers.speaks = false;
    await render(<Voice />);
    const button = screen.getByRole("button", { name: "voice.hold" });
    await act(async () => fireEvent(button, "pressIn"));
    await act(async () => jest.advanceTimersByTime(1_000));
    await act(async () => onChunk(Buffer.alloc(16_000).toString("base64"))); // silence
    await act(async () => void fireEvent(button, "pressOut"));
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => jest.advanceTimersByTime(700));
    expect(screen.getByText("আবার বলবেন?")).toBeTruthy();
    expect(jest.requireMock("./lib/audio").playAskAgain).not.toHaveBeenCalled();
    expect(streamTurn).not.toHaveBeenCalled();
  });

  // From the owner's test on 30 Sep (D111): one "audio too short" locked the microphone for five minutes.
  it("keeps the button working when speech had trouble, with a warning", async () => {
    mockHealth.speechTrouble = true;
    await render(<Voice />);
    expect(screen.getByText("offline.speech_trouble")).toBeTruthy();
    await act(async () => fireEvent(screen.getByRole("button", { name: "voice.hold" }), "pressIn"));
    expect(mockRecorder.startRecording).toHaveBeenCalledTimes(1);
  });

  it("turns the button off while the server is offline", async () => {
    mockHealth.online = false;
    mockHealth.micAllowed = false;
    await render(<Voice />);
    expect(screen.getByText("offline.mic_off")).toBeTruthy();
    await act(async () => fireEvent(screen.getByRole("button", { name: "voice.hold" }), "pressIn"));
    expect(mockRecorder.startRecording).not.toHaveBeenCalled();
  });

  it("finishes and sends a question even when the server goes offline while the button is held", async () => {
    await render(<Voice />);
    const button = screen.getByRole("button", { name: "voice.hold" });
    await act(async () => fireEvent(button, "pressIn"));
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => onChunk(loud()));
    mockHealth.online = false;
    mockHealth.micAllowed = false;
    await screen.rerender(<Voice />);
    await act(async () => void fireEvent(button, "pressOut"));
    await act(async () => jest.advanceTimersByTime(500)); // the half second more (D113)
    await act(async () => jest.advanceTimersByTime(700));
    expect(streamTurn).toHaveBeenCalledWith(
      expect.stringMatching(/\/finish$/),
      expect.objectContaining({ chunk_count: 1 }),
      expect.any(Function),
    );
  });
});
