import { act, fireEvent, render, screen } from "@testing-library/react-native";
import Voice from "../app/(app)/voice";
import { streamTurn, uploadChunk } from "./lib/stream";

// The voice page (spec 15.3, 15.8) with the recorder, the player and the server replaced: holding the button records,
// recording stops by itself at 30 s, and a quiet clip never reaches finish.

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
jest.mock("./lib/health", () => ({ useHealth: () => ({ online: true, checking: false, micAllowed: true }) }));
jest.mock("./lib/audio", () => ({
  phonePlayer: {},
  playAskAgain: jest.fn(),
  stopPlayback: jest.fn(),
}));
jest.mock("./lib/stream", () => ({ streamTurn: jest.fn(async () => undefined), uploadChunk: jest.fn() }));
jest.mock("./lib/voice", () => {
  const { createChatStore } = jest.requireActual("./lib/chat-store");
  let n = 0;
  return {
    useVoice: createChatStore({
      createConversation: async () => "conv-1",
      stream: async () => undefined,
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
  });
  afterEach(() => jest.useRealTimers());

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

  it("sends no finish for a quiet clip", async () => {
    await render(<Voice />);
    const button = screen.getByRole("button", { name: "voice.hold" });
    await act(async () => fireEvent(button, "pressIn"));
    await act(async () => jest.advanceTimersByTime(1_000));
    await act(async () => onChunk(Buffer.alloc(16_000).toString("base64"))); // silence
    await act(async () => fireEvent(button, "pressOut"));
    expect(streamTurn).not.toHaveBeenCalled();
    expect(jest.requireMock("./lib/audio").playAskAgain).toHaveBeenCalled();
    expect(uploadChunk).toHaveBeenCalled(); // the press was long enough to upload, just too quiet to finish
  });
});
