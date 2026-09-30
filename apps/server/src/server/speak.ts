import type { ReplyEvent } from "@dokaanbondhu/contracts";
import { spokenText } from "@dokaanbondhu/core";
import type { TtsProvider } from "@dokaanbondhu/engine/providers";
import { logger } from "./singletons";

// Spoken replies (spec 12.3, 15.4): the first sentence goes to text-to-speech at once, the others follow in order, one
// at a time, and each audio event carries its sentence's seq. Audio is cached in server memory (least recently used,
// 200 clips per voice and provider). If text-to-speech fails, the turn goes on as text only, with one non-fatal
// TTS_UNAVAILABLE error event. With speaking switched off (AI_SPEAK=off, D114) the speaker says nothing and reports
// no error.

const CACHE_CLIPS = 200;
const holder = globalThis as { __dokaanTtsCache?: Map<string, Map<string, Uint8Array>> };
const caches = (holder.__dokaanTtsCache ??= new Map());

function cached(providerId: string, voice: string): Map<string, Uint8Array> {
  const key = `${providerId}|${voice}`;
  let cache = caches.get(key);
  if (!cache) caches.set(key, (cache = new Map()));
  return cache;
}

export class Speaker {
  private queue: Promise<void> = Promise.resolve();
  private failed = false;
  firstAudioMs: number | null = null;

  constructor(
    private readonly tts: TtsProvider | null,
    private readonly voice: string,
    private readonly emit: (event: ReplyEvent) => void,
    private readonly startedAt: number,
    private readonly context: Record<string, unknown> = {},
    private readonly speaks = true,
  ) {}

  /** Queues one sentence; its audio event follows every earlier sentence's. */
  say(seq: number, text: string): void {
    this.queue = this.queue.then(() => this.speak(seq, text));
  }

  /** Resolves when every queued sentence has been spoken (or given up). */
  drain(): Promise<void> {
    return this.queue;
  }

  private async speak(seq: number, text: string): Promise<void> {
    if (this.failed || !this.speaks || !text.trim()) return;
    if (!this.tts) return this.fail(new Error("no text-to-speech provider"));
    const cache = cached(this.tts.id, this.voice);
    let bytes = cache.get(text);
    if (bytes) {
      cache.delete(text); // most recently used goes last
    } else {
      try {
        // Numbers as Bangla words: Parler-TTS misreads digits (P7, D109); the screen keeps them.
        bytes = (await this.tts.synthesize(spokenText(text), { voice: this.voice })).bytes;
      } catch (error) {
        return this.fail(error);
      }
    }
    cache.set(text, bytes);
    if (cache.size > CACHE_CLIPS) cache.delete(cache.keys().next().value!);
    this.firstAudioMs ??= Date.now() - this.startedAt;
    this.emit({ type: "audio", seq, mime: "audio/mpeg", data: Buffer.from(bytes).toString("base64") });
  }

  private fail(error: unknown): void {
    this.failed = true;
    logger().warn({ err: error, ...this.context }, "text-to-speech failed; the turn goes on as text");
    this.emit({
      type: "error",
      code: "TTS_UNAVAILABLE",
      message_key: "errors.TTS_UNAVAILABLE",
      fatal: false,
    });
  }
}
