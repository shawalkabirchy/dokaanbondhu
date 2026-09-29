import { ApiError } from "./api";
import { VoiceTurn, type FinishBody, type VoiceTurnDeps } from "./voice-turn";

jest.mock("./supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));

// One push-to-talk turn (spec 15.3, 15.8): a tap sends nothing, a quiet clip sends no finish and plays the bundled
// clip, the uploaded bytes equal the recorded bytes, uploads are limited and retried, and missing chunks are resent.

/** 500 ms of PCM at one amplitude (a 200 Hz tone). */
function chunk(amplitude: number, marker = 0): Uint8Array {
  const bytes = new Uint8Array(16_000);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 8000; i++)
    view.setInt16(i * 2, Math.round(amplitude * 32767 * Math.sin(i / 12.7)), true);
  bytes[0] = marker;
  return bytes;
}

function setup(overrides: Partial<VoiceTurnDeps> = {}) {
  let clock = 0;
  const uploads: { seq: number; bytes: Uint8Array }[] = [];
  const deps: VoiceTurnDeps = {
    upload: jest.fn(async (_turn, _conversation, seq, bytes) => {
      uploads.push({ seq, bytes });
    }),
    playAskAgain: jest.fn(),
    newId: () => "turn-1",
    now: () => clock,
    ...overrides,
  };
  const turn = new VoiceTurn(deps, Promise.resolve("conv-1"));
  return { turn, deps, uploads, advance: (ms: number) => (clock += ms) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("push-to-talk turn", () => {
  it("sends nothing at all for a press under 0.3 s", async () => {
    const { turn, deps, advance } = setup();
    advance(200);
    turn.add(chunk(0.3)); // the recorder's last partial chunk, flushed on release
    await flush();
    expect(turn.verdict()).toBe("short");
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it("sends no finish for a quiet clip, and plays the bundled clip instead", async () => {
    const { turn, deps, advance } = setup();
    for (let i = 0; i < 3; i++) {
      advance(500);
      turn.add(chunk(0.005)); // RMS about 0.0035, under 0.01
    }
    expect(turn.verdict()).toBe("quiet");
    expect(deps.playAskAgain).toHaveBeenCalledTimes(1);
  });

  it("uploads the recorded bytes unchanged, in order, then finishes with the count, duration and RMS", async () => {
    const { turn, uploads, advance } = setup();
    const recorded = [chunk(0.2, 1), chunk(0.3, 2), chunk(0.25, 3)];
    for (const bytes of recorded) {
      advance(500);
      turn.add(bytes);
    }
    expect(turn.verdict()).toBe("send");
    const finish = jest.fn(async (_turnId: string, _body: FinishBody) => undefined);
    await turn.send(finish);
    expect(uploads.map((upload) => upload.seq)).toEqual([0, 1, 2]);
    uploads.forEach((upload, i) => expect(upload.bytes).toEqual(recorded[i]));
    expect(finish).toHaveBeenCalledWith("turn-1", {
      conversation_id: "conv-1",
      chunk_count: 3,
      duration_ms: 1500,
      rms: expect.any(Number),
    });
    expect(finish.mock.calls[0]![1].rms).toBeGreaterThan(0.14);
  });

  it("keeps at most two uploads in flight and tries a failing chunk three times", async () => {
    let inFlight = 0;
    let most = 0;
    const tries = new Map<number, number>();
    const { turn, advance } = setup({
      upload: async (_turn, _conversation, seq) => {
        inFlight++;
        most = Math.max(most, inFlight);
        tries.set(seq, (tries.get(seq) ?? 0) + 1);
        await flush();
        inFlight--;
        if (seq === 1) throw new Error("network");
      },
    });
    advance(500);
    for (let i = 0; i < 5; i++) turn.add(chunk(0.2));
    await turn.send(async () => undefined);
    expect(most).toBe(2);
    expect(tries.get(1)).toBe(3);
    expect(tries.get(0)).toBe(1);
  });

  it("resends the chunks the server reports missing, then finishes once more", async () => {
    const { turn, uploads, advance } = setup();
    advance(500);
    turn.add(chunk(0.2));
    turn.add(chunk(0.2));
    const finish = jest
      .fn<Promise<void>, [string, FinishBody]>()
      .mockRejectedValueOnce(
        new ApiError(409, {
          code: "CHUNKS_MISSING",
          message_en: "",
          message_bn: "",
          message_bn_key: "",
          details: { missing: [1] },
        }),
      )
      .mockResolvedValueOnce(undefined);
    await turn.send(finish);
    expect(uploads.map((upload) => upload.seq)).toEqual([0, 1, 1]);
    expect(finish).toHaveBeenCalledTimes(2);
  });
});
