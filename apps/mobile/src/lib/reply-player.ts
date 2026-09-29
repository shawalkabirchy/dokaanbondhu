import { base64ToBytes } from "./pcm";

// Spoken replies in the app (spec 15.4): each audio event is saved to a temporary file and played strictly in seq
// order, even when a later sentence's audio is ready first; pressing the button again stops the playback (barge-in);
// the files are deleted when the turn ends. The phone's APIs are passed in, so the order is tested without them.

export interface PlayerDeps {
  /** Writes the MP3 to a temporary file and gives its URI. */
  save: (name: string, bytes: Uint8Array) => string;
  /** Plays one file; resolves when it has finished or was stopped. */
  play: (uri: string) => Promise<void>;
  stopPlaying: () => void;
  remove: (uri: string) => void;
}

export class ReplyPlayer {
  private readonly ready = new Map<number, string>();
  private readonly files: string[] = [];
  private next = 0;
  private playing = false;
  private stopped = false;
  private ended = false;

  constructor(
    private readonly deps: PlayerDeps,
    private readonly turnKey: string,
  ) {}

  /** One audio event of the turn. */
  add(seq: number, base64: string): void {
    if (this.stopped) return;
    const uri = this.deps.save(`${this.turnKey}-${seq}.mp3`, base64ToBytes(base64));
    this.files.push(uri);
    this.ready.set(seq, uri);
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    while (!this.stopped && this.ready.has(this.next)) {
      const uri = this.ready.get(this.next)!;
      this.ready.delete(this.next);
      this.next++;
      await this.deps.play(uri);
    }
    this.playing = false;
    if (this.ended && this.ready.size === 0) this.cleanUp();
  }

  /** The turn is done: its files go once the last sentence has played. */
  end(): void {
    this.ended = true;
    if (!this.playing) this.cleanUp();
  }

  /** Barge-in or a new turn: stop at once and play nothing more of this turn. */
  stop(): void {
    this.stopped = true;
    this.deps.stopPlaying();
    this.cleanUp();
  }

  /** Deletes the turn's files (after its last sentence has played, or when stopped). */
  private cleanUp(): void {
    for (const uri of this.files.splice(0)) {
      try {
        this.deps.remove(uri);
      } catch {
        // a file that is already gone is fine
      }
    }
  }
}
