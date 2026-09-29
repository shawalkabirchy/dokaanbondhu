import { RmsMeter } from "./pcm";

// One push-to-talk turn (spec 15.3), without the phone's APIs, so it is tested with fakes: chunks are uploaded while
// the button is held (2 in flight, 3 tries each), exactly as recorded, once the press has lasted 0.3 s, so a tap sends
// nothing at all; a clip with an RMS under 0.01 plays the bundled "abar bolben" clip instead of reaching the server;
// on release the turn is finished, and chunks the server reports missing are sent again, once. The conversation may
// still be opening when recording starts, so uploads wait for its ID instead of delaying the recorder.

export const MIN_PRESS_MS = 300;
export const MAX_RECORDING_MS = 30_000;
export const QUIET_RMS = 0.01;
const IN_FLIGHT = 2;
const TRIES = 3;

export interface FinishBody {
  conversation_id: string;
  chunk_count: number;
  duration_ms: number;
  rms: number;
}

export interface VoiceTurnDeps {
  upload: (turnId: string, conversationId: string, seq: number, bytes: Uint8Array) => Promise<void>;
  playAskAgain: () => void;
  newId: () => string;
  now: () => number;
}

/** The chunks the server reported missing, when an error says so. */
function missingOf(error: unknown): number[] | null {
  const body = (error as { body?: { code?: string; details?: { missing?: unknown } } } | null)?.body;
  if (body?.code !== "CHUNKS_MISSING" || !Array.isArray(body.details?.missing)) return null;
  return body.details.missing.filter((seq): seq is number => typeof seq === "number");
}

export class VoiceTurn {
  readonly turnId: string;
  private readonly startedAt: number;
  private endedAt: number | null = null;
  private readonly rms = new RmsMeter();
  private readonly chunks = new Map<number, Uint8Array>();
  private seq = 0;
  private readonly waiting: number[] = [];
  private running = 0;
  private drained: (() => void)[] = [];

  constructor(
    private readonly deps: VoiceTurnDeps,
    private readonly conversation: Promise<string>,
  ) {
    this.turnId = deps.newId();
    this.startedAt = deps.now();
  }

  /** One recorded chunk: measured, kept for a resend, and queued for upload. */
  add(bytes: Uint8Array): void {
    const seq = this.seq++;
    this.rms.add(bytes);
    this.chunks.set(seq, bytes);
    this.waiting.push(seq);
    if (this.deps.now() - this.startedAt >= MIN_PRESS_MS) this.pump();
  }

  private pump(): void {
    while (this.running < IN_FLIGHT && this.waiting.length) {
      const seq = this.waiting.shift()!;
      this.running++;
      void this.upload(seq).finally(() => {
        this.running--;
        this.pump();
        if (this.running === 0 && this.waiting.length === 0)
          for (const wake of this.drained.splice(0)) wake();
      });
    }
  }

  /** Uploads one chunk, trying up to three times; a chunk that still fails is reported missing at finish. */
  private async upload(seq: number): Promise<void> {
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      try {
        await this.deps.upload(this.turnId, await this.conversation, seq, this.chunks.get(seq)!);
        return;
      } catch {
        // tried again; after the last try the server's CHUNKS_MISSING brings it back
      }
    }
  }

  private whenDrained(): Promise<void> {
    if (this.running === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.drained.push(resolve));
  }

  /**
   * Called when the button is released (or at 30 s), after the recorder has flushed its last chunk: "short" for a tap,
   * "quiet" for a clip too quiet to send (the "abar bolben" clip plays), else "send".
   */
  verdict(): "short" | "quiet" | "send" {
    this.endedAt ??= this.deps.now();
    if (this.endedAt - this.startedAt < MIN_PRESS_MS || this.seq === 0) return "short";
    if (this.rms.value < QUIET_RMS) {
      this.deps.playAskAgain();
      return "quiet";
    }
    return "send";
  }

  /** Waits for the uploads, then finishes the turn; missing chunks are sent again and the turn finished once more. */
  async send(finish: (turnId: string, body: FinishBody) => Promise<void>): Promise<void> {
    this.pump();
    await this.whenDrained();
    const body: FinishBody = {
      conversation_id: await this.conversation,
      chunk_count: this.seq,
      duration_ms: Math.min((this.endedAt ?? this.deps.now()) - this.startedAt, MAX_RECORDING_MS),
      rms: Math.round(this.rms.value * 10_000) / 10_000,
    };
    try {
      await finish(this.turnId, body);
    } catch (error) {
      const missing = missingOf(error);
      if (!missing) throw error;
      for (const seq of missing) await this.upload(seq);
      await finish(this.turnId, body); // once; a second refusal is the turn's error
    }
  }
}
