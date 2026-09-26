import { describe, expect, it } from "vitest";
import { NdjsonReader, readReplyStream } from "./ndjson";

const encode = (text: string) => new TextEncoder().encode(text);

describe("NDJSON reply reader", () => {
  it("waits for the rest of a line that arrives in pieces", () => {
    const reader = new NdjsonReader();
    expect(reader.push(encode('{"type":"text","seq":0,"te'))).toEqual([]);
    expect(reader.push(encode('xt":"এক্সিও"}\n{"type":"status","state":"UNDER'))).toEqual([
      { type: "text", seq: 0, text: "এক্সিও", final: false },
    ]);
    expect(reader.push(encode('STANDING","label_key":"status.searching"}\n'))).toEqual([
      { type: "status", state: "UNDERSTANDING", label_key: "status.searching" },
    ]);
  });

  it("keeps a Bangla character split across two chunks intact", () => {
    const bytes = encode('{"type":"text","seq":1,"text":"টাকা"}\n');
    const cut = bytes.indexOf(0xe0, 30) + 1; // in the middle of a three-byte character
    const reader = new NdjsonReader();
    expect([...reader.push(bytes.slice(0, cut)), ...reader.push(bytes.slice(cut))]).toEqual([
      { type: "text", seq: 1, text: "টাকা", final: false },
    ]);
  });

  it("skips unknown event types and broken lines", () => {
    const reader = new NdjsonReader();
    expect(
      reader.push(
        encode('{"type":"hologram","x":1}\nnot json\n{"type":"done","turn_id":"t","state":"IDLE"}\n'),
      ),
    ).toEqual([{ type: "done", turn_id: "t", state: "IDLE", timings_ms: {} }]);
  });

  it("reads a last line without a newline when the stream ends", async () => {
    const chunks = [
      encode('{"type":"text","seq":0,"text":"a"}\n{"type":"done","turn_id":"t","state":"IDLE"}'),
    ];
    const events: string[] = [];
    await readReplyStream(
      { read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) },
      (event) => events.push(event.type),
    );
    expect(events).toEqual(["text", "done"]);
  });
});
