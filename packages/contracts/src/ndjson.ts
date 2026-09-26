import { parseReplyEvent, type ReplyEvent } from "./events";

// Reads an NDJSON reply (spec 15.4): bytes are decoded, split on newlines, and a partial line waits for the rest.
// Each complete line is parsed and checked; unknown event types and broken lines are skipped, never thrown.

export class NdjsonReader {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  /** Feeds a chunk of bytes; returns the events of every line it completed. */
  push(chunk: Uint8Array): ReplyEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.parse(line));
  }

  /** The stream has ended: the last line may have no newline. */
  end(): ReplyEvent[] {
    const rest = this.buffer + this.decoder.decode();
    this.buffer = "";
    return this.parse(rest);
  }

  private parse(line: string): ReplyEvent[] {
    const text = line.trim();
    if (!text) return [];
    try {
      const event = parseReplyEvent(JSON.parse(text));
      return event ? [event] : [];
    } catch {
      return [];
    }
  }
}

/** Reads a whole streamed body (a fetch Response's reader) and hands each event over as soon as its line is complete. */
export async function readReplyStream(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  onEvent: (event: ReplyEvent) => void,
): Promise<void> {
  const ndjson = new NdjsonReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) for (const event of ndjson.push(value)) onEvent(event);
  }
  for (const event of ndjson.end()) onEvent(event);
}
